import { describe, it, expect } from 'vitest';
import { generateSessionId } from '../session-id.js';
import { parseRuntimeSessionId, toRuntimeSessionId } from '../runtime-session-id.js';

const id = generateSessionId();

describe('toRuntimeSessionId', () => {
  it('keeps the plain id for users and suffixes machine / rescued', () => {
    expect(toRuntimeSessionId(id, 'user')).toBe(id);
    expect(toRuntimeSessionId(id, 'machine')).toBe(`${id}m`);
    expect(toRuntimeSessionId(id, 'rescued')).toBe(`${id}u`);
  });
});

describe('parseRuntimeSessionId', () => {
  it.each(['user', 'machine', 'rescued'] as const)('round-trips %s', (kind) => {
    expect(parseRuntimeSessionId(toRuntimeSessionId(id, kind))).toEqual({ sessionId: id, kind });
  });

  it.each([
    ['34 chars with another suffix', `${id}x`],
    ['34 chars with a symbol suffix', `${id}-`],
    ['35 chars', `${id}mm`],
    ['32 chars', id.slice(1)],
    ['symbols inside', `${id.slice(0, 32)}_m`],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(parseRuntimeSessionId(value)).toBeUndefined();
  });
});
