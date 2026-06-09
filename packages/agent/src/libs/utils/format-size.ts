/**
 * Human-readable byte-size formatting.
 *
 * Single source of truth for rendering a byte count (e.g. `1.2 GB`). Previously
 * this logic was duplicated in `s3-list-files` and `browser/client.ts`, and the
 * browser copy capped its unit table at `MB` — so any value >= 1 GB indexed past
 * the array and rendered `"<n> undefined"`. This version covers up to PB and
 * clamps the unit index so an out-of-range or corrupt size can never produce the
 * literal `"undefined"`.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const STEP = 1024;

/**
 * Format a byte count as a human-readable size string.
 *
 * - `0` → `"0 B"`.
 * - Values are scaled by 1024 and rounded to at most 2 decimals.
 * - Units run from `B` to `PB`; anything larger clamps to `PB` rather than
 *   indexing past the table.
 * - Non-finite or negative input is treated as `0` so the result never contains
 *   `"undefined"`.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  // Clamp the computed unit index into the table's bounds so we never read an
  // out-of-range (undefined) unit for absurdly large inputs.
  const rawIndex = Math.floor(Math.log(bytes) / Math.log(STEP));
  const index = Math.min(rawIndex, UNITS.length - 1);

  const value = parseFloat((bytes / Math.pow(STEP, index)).toFixed(2));
  return `${value} ${UNITS[index]}`;
}
