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

import { markActivity } from './last-activity.js';

export interface ActiveTurn {
  requestId: string;
  startedAt: Date;
  /** Verified userId of the caller who started the turn. */
  owner?: string;
  /** Present only once the turn has opted in to user stops. */
  cancel?: AbortController;
}

const activeTurns = new Map<string, ActiveTurn>();

/** @returns false when a turn is already running for the session. */
export function tryBeginTurn(sessionId: string, requestId: string, owner?: string): boolean {
  if (activeTurns.has(sessionId)) return false;
  activeTurns.set(sessionId, { requestId, startedAt: new Date(), owner });
  markActivity();
  return true;
}

/** No-op unless `requestId` owns the session's turn. */
export function endTurn(sessionId: string, requestId: string): void {
  if (activeTurns.get(sessionId)?.requestId !== requestId) return;
  activeTurns.delete(sessionId);
  // A turn can outlive its response (client disconnect), so its end is the
  // real start of idle time.
  markActivity();
}

/**
 * Opt the turn in to `{ action: 'stop' }`. Workflow steps never call this:
 * their outcome completes a durable callback, and they are stopped through
 * the workflow's own cancel.
 *
 * @returns the signal to hand to `agent.stream`, or undefined when
 *          `requestId` does not own the session's turn.
 */
export function makeTurnCancellable(sessionId: string, requestId: string): AbortSignal | undefined {
  const turn = activeTurns.get(sessionId);
  if (turn?.requestId !== requestId) return undefined;
  turn.cancel ??= new AbortController();
  return turn.cancel.signal;
}

/**
 * Abort the session's running turn. AgentCore sessions are not bound to a
 * user (any valid JWT can address any session id), so only the user who
 * started the turn may stop it.
 *
 * @returns true when a stop was signalled.
 */
export function stopTurn(sessionId: string, userId: string): boolean {
  const turn = activeTurns.get(sessionId);
  if (!turn?.cancel || !turn.owner || turn.owner !== userId) return false;
  turn.cancel.abort();
  return true;
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
