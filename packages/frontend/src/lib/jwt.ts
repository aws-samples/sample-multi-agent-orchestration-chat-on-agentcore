/**
 * JWT payload decoder that supports URL-safe base64 (RFC 7515 §3).
 *
 * WHY this exists separately from amazon-cognito-identity-js:
 *   - We only need the `sub` claim for application-level userId extraction.
 *   - Using `atob` directly fails on real Cognito tokens whose payload contains
 *     URL-safe base64 characters (`-`, `_`) or omits `=` padding.
 *   - Silently falling back to an empty `userId` (as the previous inline
 *     `try/catch` did) risks downstream authorization bypasses. Instead, these
 *     helpers throw so callers surface the problem explicitly.
 */

import { parseUserId, type UserId } from '@moca/core';

export interface JwtPayload {
  sub?: string;
  [claim: string]: unknown;
}

/**
 * Decode a JWT payload (the middle segment).
 *
 * @throws if the token does not have three dot-separated parts, the payload
 *   cannot be base64url-decoded, or the decoded text is not valid JSON.
 */
export function decodeJwtPayload(token: string): JwtPayload {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Invalid JWT: token must be a non-empty string');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`Invalid JWT format: expected 3 parts, got ${parts.length}`);
  }

  const payloadSegment = parts[1];
  const json = base64UrlDecode(payloadSegment);

  try {
    return JSON.parse(json) as JwtPayload;
  } catch (err) {
    throw new Error(
      `Invalid JWT: payload is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
}

/**
 * Extract the `sub` claim from an access (or id) token as a branded {@link UserId}.
 *
 * WHY a branded type: Cognito `sub` is always a UUID. Returning `UserId` prevents
 * accidental swaps with other UUID-shaped strings (e.g. `AgentId`, `TriggerId`)
 * and makes the contract visible at call sites. The value is validated via
 * {@link parseUserId} so malformed tokens fail fast rather than propagating an
 * unvalidated string through the authorization layer.
 *
 * @throws if decoding fails, `sub` is missing, empty, or is not a valid UUID.
 */
export function extractUserIdFromAccessToken(accessToken: string): UserId {
  const payload = decodeJwtPayload(accessToken);
  const sub = payload.sub;

  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Invalid JWT: `sub` claim is missing or empty');
  }

  return parseUserId(sub);
}

/**
 * Decode a URL-safe base64 segment into a UTF-8 string.
 *
 * Handles:
 *   - URL-safe alphabet: `-` → `+`, `_` → `/`
 *   - Missing `=` padding (length % 4 != 0)
 *   - Multi-byte UTF-8 characters via `decodeURIComponent(escape(...))`
 *     (widely-supported pre-TextDecoder idiom; no browser API assumptions).
 */
function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(paddingNeeded);

  let binary: string;
  try {
    binary = atob(padded);
  } catch (err) {
    throw new Error(
      `Invalid JWT: payload is not valid base64url (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }

  try {
    return decodeURIComponent(
      binary
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
  } catch {
    // Fallback: treat as ASCII/latin-1 if UTF-8 sequence is malformed.
    // In practice Cognito tokens are well-formed UTF-8, so this is defensive.
    return binary;
  }
}
