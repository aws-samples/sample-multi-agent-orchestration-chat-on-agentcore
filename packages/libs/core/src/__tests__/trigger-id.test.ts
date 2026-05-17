import { describe, it, expect } from 'vitest';
import { isTriggerId, parseTriggerId, TRIGGER_ID_PATTERN } from '../trigger-id.js';

describe('isTriggerId', () => {
  it('returns true for UUID v7', () => {
    expect(isTriggerId('019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f')).toBe(true);
  });

  it('returns true for legacy UUID v4', () => {
    expect(isTriggerId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('returns true for uppercase UUID', () => {
    expect(isTriggerId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isTriggerId('')).toBe(false);
  });

  it('returns false for plain string', () => {
    expect(isTriggerId('my-trigger')).toBe(false);
  });

  it('returns false for session ID (33 alphanumeric)', () => {
    expect(isTriggerId('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg')).toBe(false);
  });

  it('returns false for UUID without hyphens', () => {
    expect(isTriggerId('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});

describe('parseTriggerId', () => {
  it('returns TriggerId for valid input', () => {
    const valid = '019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f';
    expect(parseTriggerId(valid)).toBe(valid);
  });

  it('throws for invalid input', () => {
    expect(() => parseTriggerId('bad')).toThrow('Invalid triggerId');
  });

  it('throws with descriptive error message', () => {
    expect(() => parseTriggerId('xyz')).toThrow(/must be a UUID/);
  });
});

describe('TRIGGER_ID_PATTERN', () => {
  it('matches standard UUID', () => {
    expect(TRIGGER_ID_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('does not match non-UUID', () => {
    expect(TRIGGER_ID_PATTERN.test('my-trigger-name')).toBe(false);
  });
});
