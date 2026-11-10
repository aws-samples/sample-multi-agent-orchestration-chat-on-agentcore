/**
 * Timestamp reported as `/ping`'s `time_of_last_update`.
 *
 * AgentCore Runtime derives idle duration from this value, so it must be the
 * time work last started or ended — NOT the poll time. Returning `Date.now()`
 * on every poll keeps idle ≈ 0 forever and every microVM lives until
 * `maxLifetime`.
 *
 * Kept in its own module because both in-flight.ts and turn-registry.ts stamp
 * it, and in-flight.ts already imports turn-registry.ts.
 */

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// Process start counts as activity so a fresh container is not reclaimed
// before its first request arrives.
let lastActivityAt = nowSeconds();

export function markActivity(): void {
  lastActivityAt = nowSeconds();
}

/** Unix seconds of the last busy-state change. */
export function getTimeOfLastUpdate(): number {
  return lastActivityAt;
}

/** Intended for unit tests only. */
export function resetLastActivity(): void {
  lastActivityAt = nowSeconds();
}
