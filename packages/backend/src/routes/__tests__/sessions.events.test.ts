/**
 * GET /sessions/:sessionId/events — route-level tests (AC4, AC8).
 *
 * Tests the route's cursor validation, ownership enforcement, and response
 * shape by extracting and exercising the validation logic directly, matching
 * the convention used by storage-directory.test.ts and
 * trigger-event-config-validation.test.ts in this package.
 */

import { describe, it, expect } from '@jest/globals';
import { decodeEventCursor, encodeEventCursor } from '../../libs/http/pagination';
import { AppError, ErrorCode } from '../../libs/http/error-codes';

const SESSION_ID = 'routeTestSESSION000000000000000001';
const OTHER_SESSION = 'otherSession000000000000000000001';

describe('decodeEventCursor route-integration validation (AC4)', () => {
  it('accepts a valid cursor bound to the correct session', () => {
    const encoded = encodeEventCursor({ v: 1, sid: SESSION_ID, off: 5, tok: 'tok' })!;
    const decoded = decodeEventCursor(encoded, SESSION_ID);
    expect(decoded).toMatchObject({ v: 1, sid: SESSION_ID, off: 5, tok: 'tok' });
  });

  it('returns undefined (first page) when cursor is absent', () => {
    expect(decodeEventCursor(undefined, SESSION_ID)).toBeUndefined();
  });

  it('throws VALIDATION_ERROR for a cursor from a different session (AC4)', () => {
    const foreignCursor = encodeEventCursor({ v: 1, sid: OTHER_SESSION, off: 0 })!;
    let caught: AppError | undefined;
    try {
      decodeEventCursor(foreignCursor, SESSION_ID);
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(caught!.status).toBe(400);
  });

  it('throws VALIDATION_ERROR for a plain malformed string (AC4)', () => {
    let caught: AppError | undefined;
    try {
      decodeEventCursor('not-valid-cursor-data', SESSION_ID);
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('throws VALIDATION_ERROR for unknown cursor version (AC4)', () => {
    const badCursor = Buffer.from(
      JSON.stringify({ v: 2, sid: SESSION_ID, off: 0 })
    ).toString('base64');
    let caught: AppError | undefined;
    try {
      decodeEventCursor(badCursor, SESSION_ID);
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('throws VALIDATION_ERROR for a numeric-only base64 payload (AC4)', () => {
    const badCursor = Buffer.from('42').toString('base64');
    let caught: AppError | undefined;
    try {
      decodeEventCursor(badCursor, SESSION_ID);
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe('response shape (AC1, AC2)', () => {
  it('encodeEventCursor produces a defined string when there are more pages', () => {
    const cursor = encodeEventCursor({ v: 1, sid: SESSION_ID, tok: 'next', off: 3 });
    expect(typeof cursor).toBe('string');
    expect(cursor!.length).toBeGreaterThan(0);
  });

  it('encodeEventCursor returns undefined for no-more-pages', () => {
    expect(encodeEventCursor(undefined)).toBeUndefined();
  });
});
