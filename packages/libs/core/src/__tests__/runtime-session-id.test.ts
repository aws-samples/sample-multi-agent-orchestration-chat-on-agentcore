import { describe, it, expect } from 'vitest';
import { generateSessionId } from '../session-id.js';
import { parseRuntimeSessionId, toRuntimeSessionId } from '../runtime-session-id.js';

const id = generateSessionId();

describe('toRuntimeSessionId', () => {
  it('suffixes humans with u and machine callers with m', () => {
    expect(toRuntimeSessionId(id, 'user')).toBe(`${id}u`);
    expect(toRuntimeSessionId(id, 'machine')).toBe(`${id}m`);
  });
});

describe('parseRuntimeSessionId', () => {
  it.each(['user', 'machine'] as const)('round-trips %s', (kind) => {
    expect(parseRuntimeSessionId(toRuntimeSessionId(id, kind))).toEqual({ sessionId: id, kind });
  });

  it('parses a plain id from clients deployed before the split', () => {
    expect(parseRuntimeSessionId(id)).toEqual({ sessionId: id, kind: 'plain' });
  });

  it.each([
    ['34 chars with another suffix', `${id}x`],
    ['34 chars with a symbol suffix', `${id}-`],
    ['35 chars', `${id}mm`],
    ['32 chars', id.slice(1)],
    ['symbols inside', `${id.slice(0, 32)}_u`],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(parseRuntimeSessionId(value)).toBeUndefined();
  });
});
