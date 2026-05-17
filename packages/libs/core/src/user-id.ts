/**
 * UserId — Branded Type + Validator
 *
 * Represents a Cognito `sub` claim — a standard UUID (v4) with hyphens.
 * Example: "d7a41aa8-8031-70e8-4916-4c302e63588a"
 *
 * By branding this as `UserId`, the compiler prevents accidental swaps
 * with other UUID-shaped strings such as `AgentId` or `TriggerId`.
 */

import type { Brand } from './branded.js';

// ---------------------------------------------------------------------------
// Branded Type
// ---------------------------------------------------------------------------

export type UserId = Brand<string, 'UserId'>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** UUID v4/v7 pattern (8-4-4-4-12 hex with hyphens) */
export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

export function isUserId(value: string): value is UserId {
  return USER_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseUserId(value: string): UserId {
  if (!isUserId(value)) {
    throw new Error(
      `Invalid userId: must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got "${value}"`
    );
  }
  return value;
}
