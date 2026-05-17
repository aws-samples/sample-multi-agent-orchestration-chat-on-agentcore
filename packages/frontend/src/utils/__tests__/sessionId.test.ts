import { describe, it, expect } from 'vitest';
import { generateSessionId, isSessionId, parseSessionId, SESSION_ID_LENGTH } from '../sessionId';
import type { SessionId } from '../sessionId';

/**
 * Re-export verification tests.
 * The main test suite lives in packages/libs/core/src/__tests__/session-id.test.ts.
 * This file only verifies that the re-export from the frontend module works correctly.
 */
describe('sessionId re-export from @moca/core', () => {
  it('generateSessionId returns a valid SessionId', () => {
    const id: SessionId = generateSessionId();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(SESSION_ID_LENGTH);
    expect(isSessionId(id)).toBe(true);
  });

  it('isSessionId validates correctly', () => {
    expect(isSessionId('a'.repeat(33))).toBe(true);
    expect(isSessionId('short')).toBe(false);
  });

  it('parseSessionId works for valid input', () => {
    const valid = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
    expect(parseSessionId(valid)).toBe(valid);
  });

  it('parseSessionId throws for invalid input', () => {
    expect(() => parseSessionId('bad')).toThrow('Invalid sessionId');
  });
});
