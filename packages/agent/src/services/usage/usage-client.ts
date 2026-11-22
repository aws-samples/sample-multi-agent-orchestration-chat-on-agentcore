/**
 * Client for the Backend's /usage API. The Backend owns limits and usage;
 * the Runtime only reads the summary and reports what it consumed.
 *
 * Auth is re-read on every call (`getCallerAuthorizationHeader`), so a long
 * turn keeps metering with the tokens the frontend renews every 10 minutes
 * (docs/adr/long-turn-token-renewal.md) rather than the request-start copy.
 */

import type { UsageSummary } from '@moca/core';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import {
  getCallerAuthorizationHeader,
  getCallerIdToken,
  type RequestContext,
} from '../../libs/context/request-context.js';
import type { NormalizedUsage } from './normalize.js';

/** Long enough to keep turn starts cheap; short enough to see other microVMs' usage. */
export const SUMMARY_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * - `unauthorized` (401/403) is NOT an outage: the caller's tokens stopped
 *   being renewed (tab closed, trigger turn past its 1 h machine token).
 *   Callers stop the turn on it instead of failing open.
 * - `throttled` (429): the Backend is shedding load; retry later, don't drop.
 */
export type UsageCallResult<T> =
  | {
      kind: 'ok';
      value: T;
      /** When the value was read from the Backend (epoch ms). */ at?: number;
    }
  | { kind: 'unavailable' }
  | { kind: 'throttled' }
  | { kind: 'unauthorized' };

export interface UsageRecord extends NormalizedUsage {
  recordId: string;
  modelId: string;
  at: string;
}

function headers(ctx: RequestContext | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = getCallerAuthorizationHeader(undefined, ctx);
  const idToken = getCallerIdToken(undefined, ctx);
  if (auth) h['Authorization'] = auth;
  if (idToken) h['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'] = idToken;
  // Ignored for regular users; required when a machine token acts for the user.
  if (ctx?.userId) h['X-Target-User-Id'] = ctx.userId;
  return h;
}

async function call<T>(
  path: string,
  init: RequestInit,
  ctx: RequestContext | undefined,
  parse: (res: Response) => Promise<T>
): Promise<UsageCallResult<T>> {
  try {
    const res = await fetch(`${config.BACKEND_API_URL}${path}`, {
      ...init,
      headers: headers(ctx),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    if (res.status === 429) return { kind: 'throttled' };
    if (!res.ok) {
      logger.warn({ path, status: res.status }, 'usage_api_failed');
      return { kind: 'unavailable' };
    }
    return { kind: 'ok', value: await parse(res) };
  } catch (err) {
    logger.warn({ path, err }, 'usage_api_failed');
    return { kind: 'unavailable' };
  }
}

const summaryCache = new Map<string, { summary: UsageSummary; at: number }>();
/**
 * Bumped whenever this process records or the Backend acknowledges usage for
 * a user. A summary whose fetch spans a bump may predate a batch that is no
 * longer pending locally, so it is not cached (callers correct it themselves).
 */
const generation = new Map<string, number>();

/** Fetch (and cache) this month's usage for the caller. */
export async function fetchSummary(
  ctx: RequestContext | undefined
): Promise<UsageCallResult<UsageSummary>> {
  const startGeneration = ctx?.userId ? (generation.get(ctx.userId) ?? 0) : 0;
  const result = await call(
    '/usage/me',
    { method: 'GET' },
    ctx,
    async (res) => (await res.json()) as UsageSummary
  );
  if (result.kind !== 'ok') return result;
  const at = Date.now();
  if (ctx?.userId && (generation.get(ctx.userId) ?? 0) === startGeneration) {
    summaryCache.set(ctx.userId, { summary: result.value, at });
  }
  return { ...result, at };
}

/**
 * Summary for a decision: the cache while younger than SUMMARY_TTL_MS,
 * otherwise a fresh read. A stale entry may predate the previous turn's usage
 * or the month boundary, so it is only a fallback when the Backend cannot be
 * reached and the entry still belongs to the current month.
 */
export async function getSummary(
  ctx: RequestContext | undefined
): Promise<UsageCallResult<UsageSummary>> {
  const hit = ctx?.userId ? summaryCache.get(ctx.userId) : undefined;
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) {
    return { kind: 'ok', value: hit.summary, at: hit.at };
  }
  const fresh = await fetchSummary(ctx);
  if (fresh.kind === 'unavailable' && hit && Date.parse(hit.summary.period.resetsAt) > Date.now()) {
    return { kind: 'ok', value: hit.summary, at: hit.at };
  }
  return fresh;
}

export async function postRecords(
  records: readonly UsageRecord[],
  ctx: RequestContext | undefined,
  /** Same id on every retry of these records; the Backend applies each batch once. */
  batchId: string
): Promise<UsageCallResult<void>> {
  return call(
    '/usage/records',
    { method: 'POST', body: JSON.stringify({ batchId, records }) },
    ctx,
    async () => undefined
  );
}

/** Drop the caller's cached summary: this process just consumed tokens it does not reflect. */
export function invalidateSummary(userId: string | undefined): void {
  if (!userId) return;
  summaryCache.delete(userId);
  generation.set(userId, (generation.get(userId) ?? 0) + 1);
}

/** Test hook. */
export function clearSummaryCacheForTest(): void {
  summaryCache.clear();
  generation.clear();
}

/** Test hook: seed the cache with an entry read at `at`. */
export function setCachedSummaryForTest(userId: string, summary: UsageSummary, at: number): void {
  summaryCache.set(userId, { summary, at });
}
