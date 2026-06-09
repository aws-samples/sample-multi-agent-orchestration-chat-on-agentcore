import { describe, it, expect } from '@jest/globals';
import { formatFileSize } from '../format-size.js';

describe('formatFileSize', () => {
  it('returns "0 B" for zero bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats byte-range values', () => {
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats the KB boundary', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats the MB boundary', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  // The original GB bug: browser/client.ts used sizes=['B','KB','MB'] so any
  // value >= 1 GB indexed past the array and rendered "<n> undefined".
  it('formats the GB boundary (regression: must not be "undefined")', () => {
    expect(formatFileSize(1024 ** 3)).toBe('1 GB');
    expect(formatFileSize(1.2 * 1024 ** 3)).toBe('1.2 GB');
  });

  it('formats the TB boundary', () => {
    expect(formatFileSize(1024 ** 4)).toBe('1 TB');
    expect(formatFileSize(3 * 1024 ** 4)).toBe('3 TB');
  });

  it('formats the PB boundary', () => {
    expect(formatFileSize(1024 ** 5)).toBe('1 PB');
  });

  // Beyond the largest known unit, clamp to PB rather than emit "undefined".
  it('clamps absurdly large values to the largest unit instead of undefined', () => {
    const result = formatFileSize(1024 ** 7); // would index past the table
    expect(result).not.toContain('undefined');
    expect(result.endsWith(' PB')).toBe(true);
  });

  it('handles negative or NaN input defensively without "undefined"', () => {
    // Defensive: a corrupt size should never render the literal "undefined".
    expect(formatFileSize(-1)).not.toContain('undefined');
    expect(formatFileSize(Number.NaN)).not.toContain('undefined');
  });
});
