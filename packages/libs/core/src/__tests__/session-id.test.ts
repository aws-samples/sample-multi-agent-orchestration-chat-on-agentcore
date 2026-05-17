import { describe, it, expect } from 'vitest';
import {
  generateSessionId,
  isSessionId,
  parseSessionId,
  SESSION_ID_LENGTH,
  SESSION_ID_PATTERN,
} from '../session-id.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const AGENTCORE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------
describe('generateSessionId', () => {
  it('returns a string', () => {
    expect(typeof generateSessionId()).toBe('string');
  });

  it('generates a 33-character string', () => {
    const id = generateSessionId();
    expect(id).toHaveLength(SESSION_ID_LENGTH);
  });

  it('contains only alphanumeric characters (no hyphens, underscores, or special chars)', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it('first character is always alphanumeric', () => {
    for (let i = 0; i < 1000; i++) {
      const id = generateSessionId();
      expect(id[0]).toMatch(/[a-zA-Z0-9]/);
    }
  });

  it('satisfies AgentCore sessionId constraint pattern', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).toMatch(AGENTCORE_PATTERN);
    }
  });

  it('generates unique IDs across 1000 calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateSessionId()));
    expect(ids.size).toBe(1000);
  });

  it('uses only characters from the defined alphabet', () => {
    const alphabetSet = new Set(ALPHABET.split(''));
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      for (const char of id) {
        expect(alphabetSet.has(char)).toBe(true);
      }
    }
  });

  it('does not contain hyphens', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).not.toContain('-');
    }
  });

  it('does not contain underscores', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).not.toContain('_');
    }
  });

  it('produces roughly uniform character distribution (chi-square sanity check)', () => {
    const charCounts: Record<string, number> = {};
    const sampleSize = 10000;
    const totalChars = sampleSize * SESSION_ID_LENGTH;

    for (let i = 0; i < sampleSize; i++) {
      const id = generateSessionId();
      for (const char of id) {
        charCounts[char] = (charCounts[char] || 0) + 1;
      }
    }

    const uniqueChars = Object.keys(charCounts);
    expect(uniqueChars.length).toBe(62);

    const expected = totalChars / 62;
    for (const char of uniqueChars) {
      const ratio = charCounts[char] / expected;
      // Each character should appear within ±30% of expected frequency
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.3);
    }
  });

  it('has no sequential pattern across consecutive calls', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const id3 = generateSessionId();

    // Should not share a common prefix (unlike UUID v7 which shares timestamp prefix)
    const commonPrefix = (a: string, b: string) => {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return i;
    };

    // Statistically, common prefix of two random 62-alphabet strings should be very short
    expect(commonPrefix(id1, id2)).toBeLessThan(5);
    expect(commonPrefix(id2, id3)).toBeLessThan(5);
  });

  it('always passes isSessionId type guard', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(isSessionId(id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isSessionId (type guard)
// ---------------------------------------------------------------------------
describe('isSessionId', () => {
  it('returns true for valid 33-char alphanumeric string', () => {
    expect(isSessionId('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg')).toBe(true);
    expect(isSessionId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(isSessionId('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isSessionId('')).toBe(false);
  });

  it('returns false for too short string', () => {
    expect(isSessionId('abc')).toBe(false);
    expect(isSessionId('a'.repeat(32))).toBe(false);
  });

  it('returns false for too long string', () => {
    expect(isSessionId('a'.repeat(34))).toBe(false);
  });

  it('returns false for string with hyphens', () => {
    expect(isSessionId('a'.repeat(16) + '-' + 'a'.repeat(16))).toBe(false);
  });

  it('returns false for string with underscores', () => {
    expect(isSessionId('a'.repeat(16) + '_' + 'a'.repeat(16))).toBe(false);
  });

  it('returns false for string with spaces', () => {
    expect(isSessionId('a'.repeat(16) + ' ' + 'a'.repeat(16))).toBe(false);
  });

  it('returns false for string with special characters', () => {
    expect(isSessionId('a'.repeat(32) + '!')).toBe(false);
    expect(isSessionId('a'.repeat(32) + '@')).toBe(false);
  });

  it('returns false for UUID v4 format (contains hyphens)', () => {
    expect(isSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSessionId
// ---------------------------------------------------------------------------
describe('parseSessionId', () => {
  it('returns SessionId for valid input', () => {
    const valid = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
    const result = parseSessionId(valid);
    expect(result).toBe(valid);
  });

  it('throws for invalid input', () => {
    expect(() => parseSessionId('')).toThrow('Invalid sessionId');
    expect(() => parseSessionId('too-short')).toThrow('Invalid sessionId');
    expect(() => parseSessionId('a'.repeat(34))).toThrow('Invalid sessionId');
  });

  it('throws with descriptive error message', () => {
    expect(() => parseSessionId('bad')).toThrow(/must be exactly 33 alphanumeric characters/);
  });

  it('round-trips with generateSessionId', () => {
    const id = generateSessionId();
    const parsed = parseSessionId(id);
    expect(parsed).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('SESSION_ID_LENGTH is 33', () => {
    expect(SESSION_ID_LENGTH).toBe(33);
  });

  it('SESSION_ID_PATTERN matches 33-char alphanumeric strings', () => {
    expect(SESSION_ID_PATTERN.test('a'.repeat(33))).toBe(true);
    expect(SESSION_ID_PATTERN.test('a'.repeat(32))).toBe(false);
    expect(SESSION_ID_PATTERN.test('a'.repeat(34))).toBe(false);
  });
});
