/**
 * Which sessions have an agent turn running in this process.
 *
 * AgentCore does not propagate a client disconnect to the container, so a
 * turn keeps running after a page reload. Without this registry a "continue"
 * sent meanwhile starts a second agent loop on a history that is mid-tool-loop
 * and fails with an orphaned tool_use. Process-global scope is correct
 * because AgentCore pins one session to one microVM.
 *
 * Unlike the in-flight counter (released when the response closes), a turn
 * is held until `handleInvocation` returns, i.e. until the agent loop ends.
 */

export interface ActiveTurn {
  requestId: string;
  startedAt: Date;
}

const activeTurns = new Map<string, ActiveTurn>();

/** @returns false when a turn is already running for the session. */
export function tryBeginTurn(sessionId: string, requestId: string): boolean {
  if (activeTurns.has(sessionId)) return false;
  activeTurns.set(sessionId, { requestId, startedAt: new Date() });
  return true;
}

/** No-op unless `requestId` owns the session's turn. */
export function endTurn(sessionId: string, requestId: string): void {
  if (activeTurns.get(sessionId)?.requestId === requestId) activeTurns.delete(sessionId);
}

export function getActiveTurn(sessionId: string): ActiveTurn | undefined {
  return activeTurns.get(sessionId);
}

export function hasActiveTurns(): boolean {
  return activeTurns.size > 0;
}

/** Intended for unit tests only. */
export function resetTurnRegistry(): void {
  activeTurns.clear();
}
