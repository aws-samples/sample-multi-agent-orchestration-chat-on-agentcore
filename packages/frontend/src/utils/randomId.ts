/**
 * Generate a random ID for ephemeral use (React keys, local-only identifiers).
 * Uses Web Crypto API — no external dependencies.
 */
export function randomId(): string {
  return crypto.randomUUID();
}
