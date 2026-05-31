/**
 * Shared pagination helpers.
 *
 * Provides a single place to (a) parse and CLAMP a client-supplied `limit`
 * so a request like `?limit=100000` (or `?limit=-1`, or `?limit=abc`) cannot
 * force an unbounded DynamoDB read, and (b) encode/decode opaque base64
 * page tokens so the wire token never exposes the underlying store's key
 * shape.
 */

import type { Request } from 'express';
import { AppError, ErrorCode } from './error-codes.js';

/** Default page size when the client does not specify `limit`. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard upper bound on page size, regardless of what the client requests. */
export const MAX_PAGE_SIZE = 100;

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
