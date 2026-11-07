/**
 * Is a session's turn still running server-side?
 *
 * The agent writes `activeTurnStartedAt` on the session row at turn start and
 * removes it at turn end. If the runtime dies mid-turn the marker is never
 * removed, so it is only trusted while the session keeps being touched (the
 * agent bumps `updatedAt` on every user-role message, tool results included).
 * The threshold matches the AgentCore idle timeout: a session untouched for
 * that long has no microVM left. A single tool call running longer than this
 * re-enables Send early, but the runtime still answers turnInProgress.
 */

export const TURN_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * @param locallyCompletedAt When this tab last finished streaming the session.
 *   A turn that started before that is the one we just streamed; its marker
 *   is only waiting for the clear event to arrive.
 */
export function isTurnRunning(
  session: { activeTurnStartedAt?: string; updatedAt: string } | undefined,
  now: number = Date.now(),
  locallyCompletedAt?: number
): boolean {
  if (!session?.activeTurnStartedAt) return false;
  if (
    locallyCompletedAt !== undefined &&
    locallyCompletedAt >= Date.parse(session.activeTurnStartedAt)
  ) {
    return false;
  }
  return now - Date.parse(session.updatedAt) < TURN_STALE_AFTER_MS;
}
