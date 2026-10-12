/**
 * In-flight agent registry for out-of-band cancellation.
 *
 * WHY this exists
 * ---------------
 * On AgentCore Runtime a client `fetch` abort is NOT propagated to the
 * container (verified in production: no `res` 'close' fires for a disconnect,
 * the turn runs to completion). So "stop the running turn" cannot be driven by
 * the transport. Instead the frontend sends a SECOND invocation carrying
 * `{ action: 'stop' }` with the SAME runtime session id. AgentCore's
 * session-sticky routing lands that request on the SAME microVM (one session →
 * one microVM → one process), where this module lets it find the in-flight
 * `Agent` and call `agent.cancel()`.
 *
 * A process-global map is the correct scope for exactly the reason in-flight.ts
 * gives: the running turn and its stop command are guaranteed to share this
 * process. `cancel()` is cooperative — the Strands loop stops at its next
 * checkpoint and the stream returns `stopReason: 'cancelled'`.
 */

import type { Agent } from '@strands-agents/sdk';

/** sessionId → the Agent currently running a turn for that session. */
const registry = new Map<string, Agent>();

/**
 * Record the Agent running a turn for `sessionId`. A later turn for the same
 * session overwrites the entry (the newest turn is the one a stop should hit).
 */
export function registerAgent(sessionId: string, agent: Agent): void {
  registry.set(sessionId, agent);
}

/**
 * Remove the registration for `sessionId`.
 *
 * When `agent` is provided, the entry is removed ONLY if it still points at
 * that same agent. This guards the race where an old turn finishes and cleans
 * up AFTER a new turn for the same session has already registered — without the
 * guard the finishing turn would evict the new turn's agent, silently breaking
 * a subsequent stop.
 */
export function unregisterAgent(sessionId: string, agent?: Agent): void {
  if (agent && registry.get(sessionId) !== agent) {
    return;
  }
  registry.delete(sessionId);
}

/**
 * Cancel the in-flight turn for `sessionId`, if any.
 *
 * @returns true if an agent was found and cancelled, false if nothing was
 *          registered for the session (already finished, or never on this VM).
 */
export function cancelAgent(sessionId: string): boolean {
  const agent = registry.get(sessionId);
  if (!agent) {
    return false;
  }
  agent.cancel();
  return true;
}

/** True if an agent is currently registered for `sessionId`. */
export function isRegistered(sessionId: string): boolean {
  return registry.has(sessionId);
}

/** Clear the registry. Intended for unit tests only. */
export function resetRegistry(): void {
  registry.clear();
}
