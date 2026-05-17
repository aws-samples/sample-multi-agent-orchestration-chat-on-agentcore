/**
 * AgentId — Branded Type + Validator + Generator
 *
 * Represents a unique agent identifier — a UUID (v4 or v7) with hyphens.
 * New agents use UUID v7 for time-sortable IDs; legacy agents may still use v4.
 *
 * By branding this as `AgentId`, the compiler prevents accidental swaps
 * with other UUID-shaped strings such as `UserId`.
 */

import type { Brand } from './branded.js';

// ---------------------------------------------------------------------------
// Branded Type
// ---------------------------------------------------------------------------

export type AgentId = Brand<string, 'AgentId'>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** UUID v4/v7 pattern (8-4-4-4-12 hex with hyphens) */
export const AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

export function isAgentId(value: string): value is AgentId {
  return AGENT_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseAgentId(value: string): AgentId {
  if (!isAgentId(value)) {
    throw new Error(
      `Invalid agentId: must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got "${value}"`
    );
  }
  return value;
}
