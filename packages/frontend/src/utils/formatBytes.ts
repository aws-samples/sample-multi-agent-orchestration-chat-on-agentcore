/**
 * Format a byte count as a human-readable string (binary units: 1 KB = 1024 B).
 *
 * Unifies the two size formatters that previously lived in
 * StorageManagementModal. The differences between them are expressed as
 * options, keeping a single source of truth for the unit ladder and rounding.
 *
 * @param bytes  Size in bytes. `0` is a real size (renders "0 B"); only
 *               `null`/`undefined` are treated as "missing".
 * @param options.emptyPlaceholder  Returned for missing input (e.g. "—").
 *               When omitted, missing input renders as "0 B".
 * @param options.maxUnit  Highest unit to use: "MB" (default) keeps large
 *               sizes in MB; "GB" adds a GB tier.
 */
export function formatBytes(
  bytes?: number | null,
  options: { emptyPlaceholder?: string; maxUnit?: 'MB' | 'GB' } = {}
): string {
  const { emptyPlaceholder, maxUnit = 'MB' } = options;

  if (bytes == null) {
    return emptyPlaceholder ?? '0 B';
  }

  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (maxUnit === 'GB' && bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
