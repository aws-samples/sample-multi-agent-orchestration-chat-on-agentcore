/**
 * Shared pagination helpers.
 *
 * Provides a single place to (a) parse and CLAMP a client-supplied `limit`
 * so a request like `?limit=100000` (or `?limit=-1`, or `?limit=abc`) cannot
 * force an unbounded DynamoDB read, and (b) encode/decode opaque base64
 * page tokens so the wire token never exposes the underlying store's key
 * shape.
 *
 * Also exports event-history-specific cursor helpers (see `EventPageCursor`).
 */

import type { Request } from 'express';
import { AppError, ErrorCode } from './error-codes.js';

/** Default page size when the client does not specify `limit`. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard upper bound on page size, regardless of what the client requests. */
export const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Event history pagination constants
// ---------------------------------------------------------------------------

/**
 * Default number of messages returned per event-history page.
 * Set to the max: fewer round trips, and fewer toolUse/toolResult pairs split
 * across pages. PAGE_BYTE_BUDGET_BYTES still bounds the response size, so this
 * only trades a slower first paint (2-3 sequential ListEvents calls of 100)
 * for fewer requests.
 */
export const EVENTS_DEFAULT_PAGE_SIZE = 200;

/**
 * Hard upper bound on messages per event-history page.
 * Larger values are clamped without error (AIP-158 semantics).
 */
export const EVENTS_MAX_PAGE_SIZE = 200;

/**
 * Maximum serialized byte size of the `events` array in a single
 * event-history response.
 *
 * Rationale: Lambda Web Adapter (buffered mode) enforces a 6 MB synchronous
 * response limit. This budget leaves ≈1.25 MB of headroom for:
 *   - The `ok()` envelope wrapper (metadata JSON + field names)
 *   - JSON string-escaping overhead
 *   - Any future response fields
 *
 * The constant is checked with `Buffer.byteLength` of the serialised JSON
 * (UTF-8) so multi-byte characters are accounted for correctly.
 */
export const PAGE_BYTE_BUDGET_BYTES = 4_750_000;

/**
 * A single content block whose serialised size exceeds this threshold is
 * replaced with a {@link TruncatedContent} placeholder so the containing
 * page stays within {@link PAGE_BYTE_BUDGET_BYTES}.
 *
 * Set to 1/20 of the budget (≈237 KB). In practice the large blocks are
 * `toolUse` inputs, `toolResult` bodies, and `reasoning` text; a 237 KB
 * threshold catches production outliers while leaving typical blocks intact.
 */
export const BLOCK_TRUNCATE_THRESHOLD_BYTES = Math.floor(PAGE_BYTE_BUDGET_BYTES / 20);

// ---------------------------------------------------------------------------
// Event-history cursor
// ---------------------------------------------------------------------------

/**
 * Opaque cursor shape for the event-history page API.
 *
 * `tok` is the `ListEvents` nextToken that was used to FETCH the upstream page
 * currently being consumed (absent = the first upstream page, i.e. no token
 * was passed to ListEvents). `off` is how many events from that upstream page
 * have already been returned to the client in earlier responses. Together they
 * allow the service to resume exactly mid-upstream-page without gaps or
 * duplicates.
 *
 * NOTE: `ListEvents` returns events newest → oldest across upstream pages.
 * "First upstream page" therefore contains the most recent events. The cursor
 * allows the client to navigate backward through time.
 */
export interface EventPageCursor {
  /** Schema version — always 1 for this shape. */
  v: 1;
  /** Session ID bound to this cursor; rejected if it does not match the request. */
  sid: string;
  /** ListEvents nextToken used to fetch the upstream page (absent = first page). */
  tok?: string;
  /** How many events from that upstream page have already been served. */
  off: number;
}

/**
 * Encode an {@link EventPageCursor} into a URL-safe base64 string for the
 * wire. Returns `undefined` when there are no more pages.
 */
export function encodeEventCursor(cursor: EventPageCursor | undefined): string | undefined {
  if (!cursor) return undefined;
  const json = JSON.stringify(cursor);
  return Buffer.from(json)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode and validate an opaque event-history cursor.
 *
 * Throws a 400 `VALIDATION_ERROR` {@link AppError} when:
 *   - The token is malformed (not base64url JSON).
 *   - The decoded object does not have `v === 1`.
 *   - The `sid` does not match `sessionId`.
 *
 * Returns `undefined` when no cursor string is supplied (first page).
 */
export function decodeEventCursor(
  token: string | undefined,
  sessionId: string
): EventPageCursor | undefined {
  if (!token) return undefined;

  let raw: unknown;
  try {
    // Accept both standard base64 and base64url (replace URL-safe chars back).
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    raw = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format');
  }

  const obj = raw as Record<string, unknown>;

  if (obj['v'] !== 1) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported cursor version');
  }

  if (typeof obj['sid'] !== 'string' || typeof obj['off'] !== 'number') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format');
  }

  if (obj['sid'] !== sessionId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Cursor does not belong to this session');
  }

  return {
    v: 1,
    sid: obj['sid'],
    tok: typeof obj['tok'] === 'string' ? obj['tok'] : undefined,
    off: obj['off'],
  };
}

/**
 * Parse `?limit` from the request, applying a default and clamping into
 * `[1, max]`. Non-numeric / NaN / negative / zero values fall back to the
 * default. Returning fewer items than requested is allowed (AIP-158), so
 * clamping down an over-large limit is non-breaking.
 */
export function parseLimit(
  req: Request,
  def: number = DEFAULT_PAGE_SIZE,
  max: number = MAX_PAGE_SIZE
): number {
  const raw = req.query.limit;
  if (raw === undefined) return def;
  const parsed = parseInt(Array.isArray(raw) ? String(raw[0]) : String(raw), 10);
  if (Number.isNaN(parsed) || parsed < 1) return def;
  return Math.min(parsed, max);
}

/**
 * Decode an opaque base64 page token into a DynamoDB ExclusiveStartKey.
 * Returns `undefined` when no token is supplied. Throws a VALIDATION_ERROR
 * AppError (→ 400) on a malformed token so the route does not have to
 * special-case the parse.
 */
export function decodePageToken<T = Record<string, unknown>>(
  token: string | undefined
): T | undefined {
  if (!token) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pageToken format');
  }
  // A valid ExclusiveStartKey is a plain object. Reject primitives, null, and
  // arrays here so a token like base64('5') fails as a 400 rather than slipping
  // through to marshall() and surfacing as a downstream 500.
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid pageToken format');
  }
  return decoded as T;
}

/**
 * Encode a DynamoDB LastEvaluatedKey into an opaque base64 page token.
 * Returns `undefined` when there are no further pages.
 */
export function encodePageToken(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key)).toString('base64');
}

/**
 * Read a string query param, tolerating the `string | string[]` shape that
 * Express produces for repeated params.
 */
export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}
