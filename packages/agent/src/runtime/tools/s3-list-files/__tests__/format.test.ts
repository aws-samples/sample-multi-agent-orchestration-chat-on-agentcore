import { describe, it, expect } from '@jest/globals';
import { formatExpiryTime, formatFileSize, formatRelativeTime } from '../format.js';

describe('formatFileSize', () => {
  it('returns "0 B" for zero bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats byte-range values', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats the KB boundary', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats the MB boundary', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('formatExpiryTime', () => {
  it('renders hours and minutes together', () => {
    expect(formatExpiryTime(3 * 3600 + 25 * 60)).toBe('3h 25m');
  });

  it('renders whole hours, pluralizing past one', () => {
    expect(formatExpiryTime(3600)).toBe('1 hour');
    expect(formatExpiryTime(2 * 3600)).toBe('2 hours');
  });

  it('renders whole minutes, pluralizing past one', () => {
    expect(formatExpiryTime(60)).toBe('1 minute');
    expect(formatExpiryTime(30 * 60)).toBe('30 minutes');
  });

  it('renders seconds when under a minute', () => {
    expect(formatExpiryTime(45)).toBe('45 seconds');
  });
});

describe('formatRelativeTime', () => {
  it('renders a coarse relative time for a past date', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeHoursAgo)).toBe('3 hours ago');
  });

  it('renders seconds for a very recent date', () => {
    const fiveSecondsAgo = new Date(Date.now() - 5 * 1000);
    expect(formatRelativeTime(fiveSecondsAgo)).toBe('5 seconds ago');
  });
});
