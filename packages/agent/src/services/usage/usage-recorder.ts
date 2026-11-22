/**
 * Batches per-call usage and posts it to the Backend.
 *
 * Sends at most every FLUSH_INTERVAL_MS or BATCH_SIZE records, so a runaway
 * turn costs the Backend a request per few seconds, not per model call. Each
 * send brackets beginInvocation / endInvocation so the microVM is not reclaimed
 * as idle mid-flush after the turn ends.
 */

import { randomUUID } from 'node:crypto';
import { modelUsageKey } from '@moca/core';
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
/** Recorders holding queued (not yet sent) records — e.g. re-queued after a 429. */
const recordersWithQueue = new Set<UsageRecorder>();

/**
 * Per (user, model), tokens this process recorded that the Backend has not
 * acknowledged yet — across every recorder (parent turn, sub-agents, title
 * generation, image_to_text). Any Backend summary is missing exactly these.
 * Per model, because limits are per model: another model's pending usage must
 * not count against this one's.
 */
const pending = new Map<string, { input: number; output: number }>();
/**
 * Per (user, model), tokens the Backend has acknowledged since this process
 * started. A summary fetched while a batch was acknowledged may or may not
 * contain it, and the batch has already left `pending`; snapshot this before a
 * fetch and subtract the growth (see {@link missingFromSummary}).
 */
const acknowledged = new Map<string, { input: number; output: number }>();
const pendingKey = (userId: string, modelKey: string) => `${userId}\u0000${modelKey}`;

export function unacknowledgedFor(
  userId: string | undefined,
  modelKey: string
): { input: number; output: number } {
  const p = userId ? pending.get(pendingKey(userId, modelKey)) : undefined;
  return p ? { ...p } : { input: 0, output: 0 };
}

/** Opaque snapshot to take right before fetching a summary. */
export function acknowledgedSnapshot(
  userId: string | undefined,
  modelKey: string
): { input: number; output: number } {
  const a = userId ? acknowledged.get(pendingKey(userId, modelKey)) : undefined;
  return a ? { ...a } : { input: 0, output: 0 };
}

/**
 * Usage a summary fetched after `snapshot` may be missing: what is still
 * pending, plus what was acknowledged while the fetch was in flight. The
 * latter may already be in the summary — counting it twice errs on the side
 * of the limit, and lasts only until the next refresh.
 */
export function missingFromSummary(
  userId: string | undefined,
  modelKey: string,
  snapshot: { input: number; output: number }
): { input: number; output: number } {
  const p = unacknowledgedFor(userId, modelKey);
  const a = acknowledgedSnapshot(userId, modelKey);
  return {
    input: p.input + a.input - snapshot.input,
    output: p.output + a.output - snapshot.output,
  };
}

function addPending(
  userId: string | undefined,
  modelId: string,
  input: number,
  output: number
): void {
  if (!userId) return;
  const key = pendingKey(userId, modelUsageKey(modelId));
  const p = pending.get(key) ?? { input: 0, output: 0 };
  p.input += input;
  p.output += output;
  if (p.input <= 0 && p.output <= 0) pending.delete(key);
  else pending.set(key, p);
}

function addAcknowledged(userId: string | undefined, r: UsageRecord): void {
  if (!userId) return;
  const key = pendingKey(userId, modelUsageKey(r.modelId));
  const a = acknowledged.get(key) ?? { input: 0, output: 0 };
  a.input += totalInput(r);
  a.output += r.outputTokens;
  acknowledged.set(key, a);
}

/**
 * Send everything still queued and wait (bounded) for every send in flight.
 * Call before stopping the Runtime session: StopRuntimeSession kills the
 * microVM — and any queued usage with it — and beginInvocation only defers
 * idle reclaim, not an explicit stop. Queued records include batches put back
 * after a 429, whose retry timer would otherwise never fire.
 */
export async function drainUsage(timeoutMs = 5_000): Promise<void> {
  for (const recorder of [...recordersWithQueue]) void recorder.flush();
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

interface Batch {
  /** Stable across retries of the same records, so the Backend can drop duplicates. */
  batchId: string;
  records: UsageRecord[];
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
    this.enqueue([{ recordId: randomUUID(), modelId, at: new Date().toISOString(), ...n }]);
    addPending(this.ctx?.userId, modelId, totalInput(n), n.outputTokens);
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
    const records = this.queue.splice(0);
    recordersWithQueue.delete(this);
    if (records.length === 0) return this.inFlight;
    const batches: Batch[] = [];
    for (let i = 0; i < records.length; i += MAX_RECORDS_PER_REQUEST) {
      batches.push({
        batchId: randomUUID(),
        records: records.slice(i, i + MAX_RECORDS_PER_REQUEST),
      });
    }
    beginInvocation();
    const send = this.inFlight.then(() => this.send(batches)).finally(endInvocation);
    this.inFlight = send;
    inFlightSends.add(send);
    void send.finally(() => inFlightSends.delete(send));
    return send;
  }

  private enqueue(records: UsageRecord[], front = false): void {
    if (front) this.queue.unshift(...records);
    else this.queue.push(...records);
    if (this.queue.length > 0) recordersWithQueue.add(this);
  }

  private schedule(ms: number): void {
    this.timer ??= setTimeout(() => void this.flush(), ms);
    this.timer.unref?.();
  }

  private async send(batches: Batch[]): Promise<void> {
    for (let b = 0; b < batches.length; b++) {
      const { batchId, records } = batches[b];
      for (let attempt = 0; ; attempt++) {
        // The same batchId on every attempt: a retry after an ambiguous
        // failure (timeout, 5xx after a partial write) must not add twice.
        const result = await postRecords(records, this.ctx, batchId);
        if (result.kind === 'ok') {
          this.settle(records);
          for (const r of records) addAcknowledged(this.ctx?.userId, r);
          invalidateSummary(this.ctx?.userId);
          break;
        }
        if (result.kind === 'throttled') {
          this.requeue(batches.slice(b).flatMap((x) => x.records));
          return;
        }
        if (result.kind === 'unauthorized') {
          this.onUnauthorized();
          this.drop(records, 'unauthorized');
          break;
        }
        if (attempt + 1 >= RETRIES) {
          this.drop(records, 'unavailable');
          break;
        }
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  /** Throttled: keep the records (bounded) and try again later instead of losing them. */
  private requeue(records: UsageRecord[]): void {
    this.enqueue(records, true);
    const overflow = this.queue.length - MAX_QUEUED;
    if (overflow > 0) this.drop(this.queue.splice(0, overflow), 'queue_overflow');
    this.schedule(THROTTLE_RETRY_MS);
  }

  private settle(records: UsageRecord[]): void {
    for (const r of records) {
      addPending(this.ctx?.userId, r.modelId, -totalInput(r), -r.outputTokens);
    }
  }

  /** Kept as a structured log so dropped usage can be re-aggregated later. */
  private drop(records: UsageRecord[], reason: string): void {
    this.settle(records);
    logger.error({ reason, userId: this.ctx?.userId, records }, 'usage_record_dropped');
  }
}

/** Test hook: forget all process-wide recorder state. */
export function resetUsageRecordersForTest(): void {
  inFlightSends.clear();
  recordersWithQueue.clear();
  pending.clear();
  acknowledged.clear();
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
