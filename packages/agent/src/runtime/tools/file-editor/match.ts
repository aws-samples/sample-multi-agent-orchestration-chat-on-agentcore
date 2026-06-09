/**
 * Pure string-matching helpers for the file_editor tool.
 */

/**
 * Determine whether `substr` appears exactly once in `str`.
 *
 * @returns `true` for a single occurrence, `false` for multiple, and
 *   `undefined` when `substr` is not found at all.
 */
export function isSingleOccurrence(str: string, substr: string): boolean | undefined {
  const first = str.indexOf(substr);
  if (first === -1) return undefined; // Not found
  const last = str.lastIndexOf(substr);
  return first === last; // True if only one occurrence
}
