/**
 * TriggerId — Branded Type + Validator + Parser
 *
 * Represents a unique trigger identifier — a UUID (v4 or v7) with hyphens.
 * New triggers use UUID v7 for time-sortable IDs; legacy triggers may still use v4.
 *
 * By branding this as `TriggerId`, the compiler prevents accidental swaps
 * with other UUID-shaped strings such as `AgentId` or `UserId`.
 */

import type { Brand } from './branded.js';

// ---------------------------------------------------------------------------
// Branded Type
// ---------------------------------------------------------------------------

export type TriggerId = Brand<string, 'TriggerId'>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** UUID v4/v7 pattern (8-4-4-4-12 hex with hyphens) */
export const TRIGGER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

export function isTriggerId(value: string): value is TriggerId {
  return TRIGGER_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseTriggerId(value: string): TriggerId {
  if (!isTriggerId(value)) {
    throw new Error(
      `Invalid triggerId: must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got "${value}"`
    );
  }
  return value;
}
