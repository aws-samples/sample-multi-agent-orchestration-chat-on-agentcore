/**
 * Monthly per-model token limits — the contract shared by CDK (config),
 * backend (metering + policy), agent (enforcement) and frontend (display).
 *
 * Kept in one module so every package derives the same month boundary and
 * the same model key; a mismatch would silently meter into one row and
 * check another.
 */

/** Per-model limit: separate monthly input / output token caps, or none. */
export type TokenLimitValue = { readonly input: number; readonly output: number } | 'unlimited';

/** Model id (any cross-region prefix) or `default` → limit. */
export type ModelLimitMap = Readonly<Record<string, TokenLimitValue>>;

/** Deploy-time configuration, as written in `environments.ts`. */
export interface TokenLimitsConfigInput {
  /** IANA time zone that defines the month boundary. Default `Asia/Tokyo`. */
  readonly timezone?: string;
  /** Limits for users in none of the configured groups. */
  readonly limits?: ModelLimitMap;
  /** Cognito group name → limits replacing `limits` for its members. */
  readonly groups?: Readonly<Record<string, ModelLimitMap | 'unlimited'>>;
}

/** Resolved configuration used by the backend. */
export interface TokenLimitsConfig extends TokenLimitsConfigInput {
  readonly timezone: string;
  /** Model keys accepted for metering; anything else is metered as {@link OTHER_MODEL_KEY}. */
  readonly allowedModelKeys: readonly string[];
}

export const DEFAULT_TOKEN_LIMIT_TIMEZONE = 'Asia/Tokyo';
export const DEFAULT_LIMIT_KEY = 'default';
export const OTHER_MODEL_KEY = 'other';
/** Share of a limit at which a model is reported as `warning`. */
export const TOKEN_LIMIT_WARNING_RATIO = 0.8;

/** Stream event codes (serverErrorEvent / serverWarningEvent `code`). */
export const TOKEN_LIMIT_EXCEEDED = 'tokenLimitExceeded';
export const TOKEN_LIMIT_REACHED = 'tokenLimitReached';
export const USAGE_METERING_UNAVAILABLE = 'usageMeteringUnavailable';

export type UsageStatus = 'ok' | 'warning' | 'exceeded';
export type TokenDimension = 'input' | 'output';

export interface UsageDimension {
  readonly used: number;
  /** null = unlimited */
  readonly limit: number | null;
}

export interface ModelUsage {
  readonly modelKey: string;
  readonly input: UsageDimension;
  readonly output: UsageDimension;
  readonly status: UsageStatus;
}

/** `GET /usage/me` response body. */
export interface UsageSummary {
  readonly enabled: boolean;
  readonly period: { readonly month: string; readonly timezone: string; readonly resetsAt: string };
  /** Groups that changed this user's limits. */
  readonly groups: readonly string[];
  /** Every model with usage this month or a finite limit. */
  readonly models: readonly ModelUsage[];
}

/** Details attached to tokenLimitExceeded / tokenLimitReached events. */
export interface TokenLimitEventDetail {
  readonly modelKey: string;
  readonly dimension: TokenDimension;
  readonly used: number;
  readonly limit: number;
  readonly resetsAt: string;
}

const PROFILE_PREFIX = /^(global|us|eu|apac|au|jp)\./;

/**
 * Metering key for a model id: the id without its cross-region inference
 * profile prefix, so `jp.` and `global.` profiles of one model share a limit.
 */
export function modelUsageKey(modelId: string): string {
  return modelId.trim().replace(PROFILE_PREFIX, '');
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** `YYYY-MM` of `date` in `timeZone`. */
export function usageMonth(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** UTC instant at which local wall-clock `y-m-1 00:00` occurs in `timeZone`. */
function zonedMonthStart(year: number, month: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, 1);
  // Two passes settle DST transitions; one is exact for fixed-offset zones.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    t = guess - (asUtc - t);
  }
  return new Date(t);
}

/** ISO instant at which the month after `month` (`YYYY-MM`) starts in `timeZone`. */
export function usageMonthResetsAt(month: string, timeZone: string): string {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return zonedMonthStart(next.y, next.m, timeZone).toISOString();
}

function lookup(map: ModelLimitMap | undefined, modelKey: string): TokenLimitValue | undefined {
  if (!map) return undefined;
  for (const [id, value] of Object.entries(map)) {
    if (id !== DEFAULT_LIMIT_KEY && modelUsageKey(id) === modelKey) return value;
  }
  return map[DEFAULT_LIMIT_KEY];
}

function toPair(value: TokenLimitValue | undefined): {
  input: number | null;
  output: number | null;
} {
  if (value === undefined || value === 'unlimited') return { input: null, output: null };
  return { input: value.input, output: value.output };
}

/** null (unlimited) wins; otherwise the larger cap. */
function looser(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.max(a, b);
}

/**
 * The limit that applies to `modelKey` for a member of `groups`.
 *
 * Configured groups replace the base `limits` entirely (even when stricter —
 * an explicit group setting wins), and across several groups the loosest value
 * per dimension applies. Users in no configured group get the base limits.
 */
export function resolveModelLimit(
  config: TokenLimitsConfigInput,
  groups: readonly string[],
  modelKey: string
): { input: number | null; output: number | null; groups: string[] } {
  const matched = groups.filter((g) => config.groups?.[g] !== undefined);
  if (matched.length === 0) {
    return { ...toPair(lookup(config.limits, modelKey)), groups: [] };
  }
  let result: { input: number | null; output: number | null } | undefined;
  for (const g of matched) {
    const groupConfig = config.groups![g];
    const pair = toPair(groupConfig === 'unlimited' ? 'unlimited' : lookup(groupConfig, modelKey));
    result = result
      ? { input: looser(result.input, pair.input), output: looser(result.output, pair.output) }
      : pair;
  }
  return { ...result!, groups: matched };
}

/** Every model key named in the config (for listing limits without usage). */
export function configuredModelKeys(
  config: TokenLimitsConfigInput,
  groups: readonly string[]
): string[] {
  const maps: (ModelLimitMap | undefined)[] = [config.limits];
  for (const g of groups) {
    const gc = config.groups?.[g];
    if (gc && gc !== 'unlimited') maps.push(gc);
  }
  const keys = new Set<string>();
  for (const map of maps) {
    for (const id of Object.keys(map ?? {}))
      if (id !== DEFAULT_LIMIT_KEY) keys.add(modelUsageKey(id));
  }
  return [...keys];
}

export function usageStatus(input: UsageDimension, output: UsageDimension): UsageStatus {
  const ratio = (d: UsageDimension) =>
    d.limit === null ? 0 : d.limit === 0 ? 1 : d.used / d.limit;
  const worst = Math.max(ratio(input), ratio(output));
  if (worst >= 1) return 'exceeded';
  if (worst >= TOKEN_LIMIT_WARNING_RATIO) return 'warning';
  return 'ok';
}

/** The dimension that has reached its limit, if any (input checked first). */
export function exceededDimension(
  usage: Pick<ModelUsage, 'input' | 'output'>
): TokenDimension | undefined {
  for (const d of ['input', 'output'] as const) {
    const { used, limit } = usage[d];
    if (limit !== null && used >= limit) return d;
  }
  return undefined;
}
