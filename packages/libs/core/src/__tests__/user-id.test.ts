import { describe, it, expect } from 'vitest';
import { isUserId, parseUserId, USER_ID_PATTERN } from '../user-id.js';

describe('isUserId', () => {
  it('returns true for valid Cognito sub UUID', () => {
    expect(isUserId('d7a41aa8-8031-70e8-4916-4c302e63588a')).toBe(true);
  });

  it('returns true for UUID v7', () => {
    expect(isUserId('019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f')).toBe(true);
  });

  it('returns true for uppercase hex', () => {
    expect(isUserId('D7A41AA8-8031-70E8-4916-4C302E63588A')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isUserId('')).toBe(false);
  });

  it('returns false for plain string', () => {
    expect(isUserId('not-a-uuid')).toBe(false);
  });

  it('returns false for UUID without hyphens', () => {
    expect(isUserId('00000000000000000000000000000000')).toBe(false);
  });

  it('returns false for session ID (33 alphanumeric)', () => {
    expect(isUserId('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg')).toBe(false);
  });
});

describe('parseUserId', () => {
  it('returns UserId for valid input', () => {
    const valid = 'd7a41aa8-8031-70e8-4916-4c302e63588a';
    expect(parseUserId(valid)).toBe(valid);
  });

  it('throws for invalid input', () => {
    expect(() => parseUserId('bad')).toThrow('Invalid userId');
  });

  it('throws with descriptive error message', () => {
    expect(() => parseUserId('xyz')).toThrow(/must be a UUID/);
  });
});

describe('USER_ID_PATTERN', () => {
  it('matches standard UUID', () => {
    expect(USER_ID_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('does not match non-UUID', () => {
    expect(USER_ID_PATTERN.test('hello-world')).toBe(false);
  });
});
