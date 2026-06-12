import { describe, it, expect } from 'vitest';
import { formatBytes } from '../formatBytes';

/**
 * formatBytes unifies the two byte-formatting variants that previously lived
 * inside StorageManagementModal (the per-item `formatSize` and the
 * directory-warning `formatSizeForWarning`). The behavioural differences
 * between them are expressed here as options.
 */
describe('formatBytes', () => {
  it('formats bytes below 1 KiB with the B unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KiB and MiB with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('caps at MB by default (no GB tier)', () => {
    // 2 GiB rendered in MB by default.
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2048.0 MB');
  });

  it('renders GB when maxUnit is "GB"', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024, { maxUnit: 'GB' })).toBe('2.0 GB');
    // Below the GB threshold still shows MB even with maxUnit GB.
    expect(formatBytes(5 * 1024 * 1024, { maxUnit: 'GB' })).toBe('5.0 MB');
  });

  it('treats 0 as a real size, not "missing" (regression: 0-byte file showed em dash)', () => {
    // Default has no placeholder, so 0 must render as "0 B", never an em dash.
    expect(formatBytes(0)).toBe('0 B');
  });

  it('returns the placeholder only for null/undefined when one is provided', () => {
    expect(formatBytes(undefined, { emptyPlaceholder: '—' })).toBe('—');
    expect(formatBytes(null as unknown as undefined, { emptyPlaceholder: '—' })).toBe('—');
    // 0 is a real value and must NOT use the placeholder.
    expect(formatBytes(0, { emptyPlaceholder: '—' })).toBe('0 B');
  });

  it('returns "0 B" for missing input when no placeholder is configured', () => {
    expect(formatBytes(undefined)).toBe('0 B');
  });
});
