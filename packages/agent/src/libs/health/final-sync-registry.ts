/**
 * Final-sync registry — keeps `/ping` returning HealthyBusy while a
 * post-turn workspace flush is in progress.
 *
 * WHY this exists
 * ---------------
 * The `WorkspaceSyncHook` pushes to S3 after every tool execution, but files
 * written after the last tool call (e.g. assistant cleanup code, final output)
 * might not reach S3 before the microVM becomes idle and is reclaimed.
 *
 * After `streamAgentResponse` returns, `runTurn` performs one final
 * `WorkspaceSync.syncToS3()` with a 60-second timeout. During that window,
 * this module ensures `isBusy()` returns `true` so `/ping` reports
 * `HealthyBusy` and the platform does not reclaim the container.
 *
 * The session-terminator (`stopOwnSession`) must run only AFTER the sync
 * completes — `runTurn` calls `beginFinalSync / endFinalSync` around the push
 * and defers `stopOwnSession` until after `endFinalSync`.
 *
 * Process-global scope is correct for the same reason as `in-flight.ts`:
 * one process serves one session and `/ping` is process-wide.
 */

/** Number of final syncs currently in progress. */
let pendingFinalSyncs = 0;

/** Increment the counter before starting a final sync. */
export function beginFinalSync(): void {
  pendingFinalSyncs += 1;
}

/**
 * Decrement the counter after a final sync completes or times out.
 * Clamped at zero to guard against unbalanced calls.
 */
export function endFinalSync(): void {
  pendingFinalSyncs = Math.max(0, pendingFinalSyncs - 1);
}

/** True while at least one final sync is in progress. */
export function hasPendingFinalSyncs(): boolean {
  return pendingFinalSyncs > 0;
}

/** Reset to zero. Intended for unit tests only. */
export function resetFinalSyncRegistry(): void {
  pendingFinalSyncs = 0;
}
