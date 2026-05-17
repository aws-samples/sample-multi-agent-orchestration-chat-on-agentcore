/**
 * SessionId — Branded Type + Generator + Validator
 *
 * AgentCore Runtime session ID naming constraints:
 *
 * | Component                    | Min | Max | Pattern                         | Hyphens/Underscores |
 * |-----------------------------|-----|-----|---------------------------------|---------------------|
 * | Runtime (request)            | 33  | 256 | [a-zA-Z0-9][a-zA-Z0-9-_]*     | Allowed             |
 * | Runtime (response header)    | 1   | 100 | [a-zA-Z0-9][a-zA-Z0-9-_]*     | Allowed             |
 * | Memory                       | 1   | 100 | [a-zA-Z0-9][a-zA-Z0-9-_]*     | Allowed             |
 * | CodeInterpreter / Browser    | 1   | 40  | [0-9a-zA-Z]{1,40}             | Not allowed         |
 *
 * Since the same session ID is shared across Runtime, Memory, and CodeInterpreter/Browser,
 * we adopt a format that satisfies the intersection of all constraints:
 * - 33 characters (Runtime minimum length)
 * - [a-zA-Z0-9] only (CodeInterpreter/Browser disallows hyphens)
 * - Within 40 characters (CodeInterpreter/Browser maximum length)
 */

import type { Brand } from './branded.js';
import { getSecureRandomBytes } from './crypto.js';

// ---------------------------------------------------------------------------
// Branded Type
// ---------------------------------------------------------------------------

/**
 * Branded type that uniquely identifies an AgentCore session.
 * Implicit conversion from a plain string is not possible.
 * Use `generateSessionId()` to create new IDs, or `parseSessionId()` to convert external input.
 */
export type SessionId = Brand<string, 'SessionId'>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of characters in a session ID */
export const SESSION_ID_LENGTH = 33;

/** Character set: uppercase + lowercase + digits = 62 characters */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Bitmask: 2^6 - 1 = 63 (smallest 2^n - 1 >= ALPHABET size of 62) */
const MASK = 63;

/** Exact match pattern for a valid session ID */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9]{33}$/;

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether a given string is a valid SessionId.
 *
 * @param value - The string to validate
 * @returns true if value satisfies the SessionId constraints
 */
export function isSessionId(value: string): value is SessionId {
  return SESSION_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Validate external input (HTTP headers, URL parameters, etc.) and convert to SessionId.
 * Throws an error if the value is invalid.
 *
 * @param value - The string to validate
 * @returns The validated SessionId
 * @throws Error if the value does not satisfy SessionId constraints
 */
export function parseSessionId(value: string): SessionId {
  if (!isSessionId(value)) {
    throw new Error(
      `Invalid sessionId: must be exactly ${SESSION_ID_LENGTH} alphanumeric characters, got "${value}"`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a new cryptographically secure SessionId.
 *
 * Algorithm:
 * 1. Allocate a batch of random bytes for rejection sampling
 * 2. Mask each byte with MASK; accept only values within ALPHABET range
 * 3. If the batch is exhausted before 33 characters are collected,
 *    allocate a fresh batch and continue (prevents undefined-read bias)
 *
 * With MASK=63 and ALPHABET=62, the rejection rate is 2/64 ≈ 3.1%.
 * A single batch of 66 bytes is expected to yield ~64 accepted characters,
 * far more than the 33 required. The refill path exists only as a safety net.
 *
 * @returns A new SessionId (33 alphanumeric characters)
 */
export function generateSessionId(): SessionId {
  const BATCH_SIZE = SESSION_ID_LENGTH * 2; // 66 bytes per batch
  let bytes = getSecureRandomBytes(BATCH_SIZE);
  let result = '';
  let pos = 0;
  while (result.length < SESSION_ID_LENGTH) {
    // Safety: refill random bytes if current batch is exhausted
    if (pos >= bytes.length) {
      bytes = getSecureRandomBytes(BATCH_SIZE);
      pos = 0;
    }
    const idx = bytes[pos++] & MASK;
    if (idx < ALPHABET.length) {
      result += ALPHABET[idx];
    }
  }
  return result as SessionId;
}
