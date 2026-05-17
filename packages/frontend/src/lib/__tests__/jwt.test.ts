/**
 * Unit tests for jwt.ts
 *
 * Focus: URL-safe base64 handling and fail-loud semantics.
 */
import { describe, it, expect } from 'vitest';
import { decodeJwtPayload, extractUserIdFromAccessToken } from '../jwt';

// ---- Helpers ----

/** Encode a JSON payload into a JWT-like token using standard base64url. */
function makeToken(payload: unknown, { urlSafe = true }: { urlSafe?: boolean } = {}): string {
  const json = JSON.stringify(payload);
  // `unescape(encodeURIComponent(...))` handles UTF-8 before btoa.
  const base64 = btoa(unescape(encodeURIComponent(json)));
  const payloadSegment = urlSafe
    ? base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : base64;
  // Header and signature are irrelevant to the decoder under test.
  return `header.${payloadSegment}.signature`;
}

describe('decodeJwtPayload', () => {
  it('decodes an ASCII-only payload and exposes claims', () => {
    const token = makeToken({ sub: 'user-123', email: 'alice@example.com' });

    const payload = decodeJwtPayload(token);

    expect(payload.sub).toBe('user-123');
    expect(payload.email).toBe('alice@example.com');
  });

  it('decodes a payload containing multi-byte UTF-8 characters', () => {
    const token = makeToken({ sub: 'user-123', name: '山田太郎' });

    const payload = decodeJwtPayload(token);

    expect(payload.sub).toBe('user-123');
    expect(payload.name).toBe('山田太郎');
  });

  it('decodes a URL-safe base64 segment (-, _, no padding)', () => {
    // Forge a payload that produces '+' and '/' in standard base64 so the
    // urlSafe path actually exercises the character substitution.
    const token = makeToken({ sub: 'abc>?>?', extra: '???' });

    expect(token.split('.')[1]).not.toContain('+');
    expect(token.split('.')[1]).not.toContain('/');

    const payload = decodeJwtPayload(token);
    expect(payload.sub).toBe('abc>?>?');
  });

  it('throws when token does not have 3 segments', () => {
    expect(() => decodeJwtPayload('only.two')).toThrow(/expected 3 parts/);
    expect(() => decodeJwtPayload('a.b.c.d')).toThrow(/expected 3 parts/);
  });

  it('throws when token is empty or non-string', () => {
    expect(() => decodeJwtPayload('')).toThrow();
    // @ts-expect-error intentional invalid input
    expect(() => decodeJwtPayload(null)).toThrow();
  });

  it('throws when payload segment is not valid base64url', () => {
    // '@' is not in the base64url alphabet — atob will throw.
    expect(() => decodeJwtPayload('header.@@@@.signature')).toThrow();
  });

  it('throws when payload is not valid JSON', () => {
    // Encode raw bytes that do not form JSON.
    const notJson = btoa('not-json-at-all').replace(/=+$/, '');
    expect(() => decodeJwtPayload(`header.${notJson}.signature`)).toThrow(/not valid JSON/);
  });
});

describe('extractUserIdFromAccessToken', () => {
  // Real Cognito `sub` is always a UUID; these tests mirror that contract.
  const VALID_SUB = 'd7a41aa8-8031-70e8-4916-4c302e63588a';

  it('returns the sub claim on success (branded UserId)', () => {
    const token = makeToken({ sub: VALID_SUB });
    expect(extractUserIdFromAccessToken(token)).toBe(VALID_SUB);
  });

  it('throws when sub is missing', () => {
    const token = makeToken({ email: 'alice@example.com' });
    expect(() => extractUserIdFromAccessToken(token)).toThrow(/sub.*missing/i);
  });

  it('throws when sub is an empty string', () => {
    const token = makeToken({ sub: '' });
    expect(() => extractUserIdFromAccessToken(token)).toThrow(/sub.*empty/i);
  });

  it('throws when sub is a non-string value', () => {
    const token = makeToken({ sub: 12345 });
    expect(() => extractUserIdFromAccessToken(token)).toThrow(/sub/i);
  });

  it('throws when sub is not a valid UUID', () => {
    // `parseUserId` from @moca/core must reject non-UUID strings so a malformed
    // token cannot silently become a "valid" userId downstream.
    const token = makeToken({ sub: 'not-a-uuid' });
    expect(() => extractUserIdFromAccessToken(token)).toThrow(/userId/i);
  });

  it('propagates decode errors (malformed token)', () => {
    expect(() => extractUserIdFromAccessToken('not-a-jwt')).toThrow();
  });
});
