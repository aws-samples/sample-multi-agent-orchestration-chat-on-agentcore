import { describe, it, expect } from 'vitest';
import { randomId } from '../randomId';

describe('randomId', () => {
  it('returns a string', () => {
    expect(typeof randomId()).toBe('string');
  });

  it('returns a valid UUID format', () => {
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs across 100 calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
  });
});
