/**
 * Batches per-call usage and posts it to the Backend.
 *
 * Sends at most every FLUSH_INTERVAL_MS or BATCH_SIZE records, so a runaway
 * turn costs the Backend a request per few seconds, not per model call. Each
 * send brackets beginInvocation / endInvocation so the microVM is not reclaimed
 * as idle mid-flush after the turn ends.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../../libs/logger/index.js';
import { beginInvocation, endInvocation } from '../../libs/health/in-flight.js';
import { getCurrentContext, type RequestContext } from '../../libs/context/request-context.js';
import { normalizeUsage, totalInput, type SdkUsage } from './normalize.js';
import { invalidateSummary, postRecords, type UsageRecord } from './usage-client.js';

export const FLUSH_INTERVAL_MS = 5_000;
export const BATCH_SIZE = 20;
const MAX_RECORDS_PER_REQUEST = 50;
const RETRIES = 3;
/** A throttled batch is put back and retried after this long. */
export const THROTTLE_RETRY_MS = 10_000;
/** Bound on records kept while throttled; beyond it the oldest are dropped (logged). */
export const MAX_QUEUED = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every send in flight, so a turn can wait for them before its microVM is stopped. */
const inFlightSends = new Set<Promise<void>>();

/**
 * Per user, tokens this process recorded that the Backend has not acknowledged
 * yet — across every recorder (parent turn, sub-agents, title generation,
 * image_to_text). Any Backend summary is missing exactly these.
 */
const pendingByUser = new Map<string, { input: number; output: number }>();

export function unacknowledgedFor(userId: string | undefined): { input: number; output: number } {
  const p = userId ? pendingByUser.get(userId) : undefined;
  return p ? { ...p } : { input: 0, output: 0 };
}

function addPending(userId: string | undefined, input: number, output: number): void {
  if (!userId) return;
  const p = pendingByUser.get(userId) ?? { input: 0, output: 0 };
  p.input += input;
  p.output += output;
  if (p.input <= 0 && p.output <= 0) pendingByUser.delete(userId);
  else pendingByUser.set(userId, p);
}

/**
 * Wait (bounded) for every usage send in flight. Call before stopping the
 * Runtime session: StopRuntimeSession kills the microVM — and any queued usage
 * with it — and beginInvocation only defers idle reclaim, not an explicit stop.
 */
export async function drainUsage(timeoutMs = 5_000): Promise<void> {
  if (inFlightSends.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...inFlightSends]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

export class UsageRecorder {
  private queue: UsageRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: RequestContext | undefined,
    /** Called when the Backend rejects the caller's tokens (401/403). */
    private readonly onUnauthorized: () => void = () => {}
  ) {}

  record(modelId: string, usage: SdkUsage): void {
    const n = normalizeUsage(modelId, usage);
    if (totalInput(n) + n.outputTokens === 0) return;
    this.queue.push({ recordId: randomUUID(), modelId, at: new Date().toISOString(), ...n });
    addPending(this.ctx?.userId, totalInput(n), n.outputTokens);
    invalidateSummary(this.ctx?.userId);
    if (this.queue.length >= BATCH_SIZE) {
      void this.flush();
    } else {
      this.schedule(FLUSH_INTERVAL_MS);
    }
  }

  /** Send everything queued so far. Sends are serialized; resolves when this batch is done. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.queue.splice(0);
    if (batch.length === 0) return this.inFlight;
    beginInvocation();
    const send = this.inFlight.then(() => this.send(batch)).finally(endInvocation);
    this.inFlight = send;
    inFlightSends.add(send);
    void send.finally(() => inFlightSends.delete(send));
    return send;
  }

  private schedule(ms: number): void {
    this.timer ??= setTimeout(() => void this.flush(), ms);
    this.timer.unref?.();
  }

  private async send(batch: UsageRecord[]): Promise<void> {
    for (let i = 0; i < batch.length; i += MAX_RECORDS_PER_REQUEST) {
      const chunk = batch.slice(i, i + MAX_RECORDS_PER_REQUEST);
      for (let attempt = 0; ; attempt++) {
        const result = await postRecords(chunk, this.ctx);
        if (result.kind === 'ok') {
          this.settle(chunk);
          break;
        }
        if (result.kind === 'throttled') {
          this.requeue(batch.slice(i));
          return;
        }
        if (result.kind === 'unauthorized') {
          this.onUnauthorized();
          this.drop(chunk, 'unauthorized');
          break;
        }
        if (attempt + 1 >= RETRIES) {
          this.drop(chunk, 'unavailable');
          break;
        }
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  /** Throttled: keep the records (bounded) and try again later instead of losing them. */
  private requeue(records: UsageRecord[]): void {
    this.queue.unshift(...records);
    const overflow = this.queue.length - MAX_QUEUED;
    if (overflow > 0) this.drop(this.queue.splice(0, overflow), 'queue_overflow');
    this.schedule(THROTTLE_RETRY_MS);
  }

  private settle(records: UsageRecord[]): void {
    for (const r of records) {
      addPending(this.ctx?.userId, -totalInput(r), -r.outputTokens);
    }
  }

  /** Kept as a structured log so dropped usage can be re-aggregated later. */
  private drop(records: UsageRecord[], reason: string): void {
    this.settle(records);
    logger.error({ reason, userId: this.ctx?.userId, records }, 'usage_record_dropped');
  }
}

/**
 * One-off metering for Bedrock calls made outside a Strands agent
 * (title generation, image_to_text). Fire-and-forget.
 */
export function recordUsageOutsideAgent(modelId: string, usage: SdkUsage | undefined): void {
  if (!usage) return;
  const recorder = new UsageRecorder(getCurrentContext());
  recorder.record(modelId, usage);
  void recorder.flush();
}
