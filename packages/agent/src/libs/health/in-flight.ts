/**
 * In-flight invocation tracker for the `/ping` health endpoint.
 *
 * WHY this exists
 * ---------------
 * AgentCore Runtime decides a session is **Idle** — and reclaims its microVM by
 * sending SIGTERM — when it observes no activity. Synchronous `InvokeAgentRuntime`
 * calls are auto-tracked by the platform, BUT a long agent turn that streams for
 * minutes (tool execution, sub-agent invokes, gaps between model chunks) can be
 * misread as Idle, especially with a shortened `idleRuntimeSessionTimeout`. When
 * that happens mid-turn, the container is killed after a tool's `toolUse` was
 * persisted but before its `toolResult` — corrupting the saved history.
 *
 * The platform's escape hatch: the agent reports `HealthyBusy` from its health
 * ping while it is genuinely busy, and the platform keeps the session Active.
 *
 * This module is the single source of truth for "is a turn currently running":
 * `handleInvocation` brackets each turn with {@link beginInvocation} /
 * {@link endInvocation}, and {@link handlePing} reports `HealthyBusy` whenever
 * {@link isBusy} is true.
 *
 * A process-global counter is the right scope here: AgentCore pins one session
 * to one microVM (one process), and `/ping` is process-wide. A simple module
 * singleton therefore mirrors exactly what the platform is asking about — no
 * per-request context plumbing required.
 */

import { hasActiveTurns } from './turn-registry.js';
import { hasPendingFinalSyncs } from './final-sync-registry.js';
import { markActivity } from './last-activity.js';

/** Number of invocations currently being processed by this container. */
let inFlight = 0;

/**
 * Mark the start of an invocation. Call once at the top of each turn; pair with
 * exactly one {@link endInvocation} in a `finally` block.
 */
export function beginInvocation(): void {
  inFlight += 1;
  markActivity();
}

/**
 * Mark the end of an invocation. Clamped at zero so an unbalanced call (e.g. a
 * double-decrement on an error path) can never drive the gauge negative — a
 * negative counter would make a genuinely busy container report Idle and
 * reintroduce the mid-turn SIGTERM this module exists to prevent.
 */
export function endInvocation(): void {
  inFlight = Math.max(0, inFlight - 1);
  markActivity();
}

/** Current number of in-flight invocations. */
export function getInFlightCount(): number {
  return inFlight;
}

/**
 * True while at least one invocation is being processed, a turn is still
 * running after its client disconnected, or a final workspace sync is in
 * progress after a turn completed.
 *
 * The final-sync window (up to 60 s) prevents the platform from reclaiming
 * the microVM before the last S3 push has finished.
 */
export function isBusy(): boolean {
  return inFlight > 0 || hasActiveTurns() || hasPendingFinalSyncs();
}

/** Reset the counter to zero. Intended for unit tests only. */
export function resetInFlight(): void {
  inFlight = 0;
}
