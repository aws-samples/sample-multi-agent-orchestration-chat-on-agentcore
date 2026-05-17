/**
 * Shared helpers for Zustand stores.
 *
 * Provides reusable patterns to reduce boilerplate across stores,
 * such as async action wrappers with loading/error state management.
 */

/**
 * Extract error message from an unknown thrown value.
 *
 * @param error - The caught error value
 * @param fallback - Fallback message when the error is not an Error instance
 * @returns A human-readable error message string
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
