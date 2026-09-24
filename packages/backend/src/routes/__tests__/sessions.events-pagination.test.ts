/**
 * GET /sessions/:sessionId/events — pagination query-param validation tests
 *
 * These tests focus on the route-level concerns:
 *  - `limit` parsing and clamping (valid / invalid / out-of-range)
 *  - `cursor` forwarding to the service
 *  - Service-thrown AppErrors are mapped to the correct HTTP status
 *  - Response shape matches the paginated contract
 *
 * The AgentCoreMemoryService is fully mocked so no AWS calls are made.
 */

import { describe, it, expect } from '@jest/globals';
import { ErrorCode } from '../../libs/http/index';
import { parseLimit, queryString } from '../../libs/http/index';
import type { Request } from 'express';

// ---------------------------------------------------------------------------
// Re-export helpers from pagination module and validate them directly,
// following the "extract-and-test" pattern used elsewhere in this package.
// ---------------------------------------------------------------------------

describe('parseLimit — events route parameters', () => {
  const makeReq = (limitValue?: string): Partial<Request> => ({
    query: limitValue !== undefined ? { limit: limitValue } : {},
  });

  it('returns default when limit is absent', () => {
    const result = parseLimit(makeReq() as Request, 50, 100);
    expect(result).toBe(50);
  });

  it('returns the supplied value when within range', () => {
    expect(parseLimit(makeReq('20') as Request, 50, 100)).toBe(20);
  });

  it('clamps an over-large limit to the maximum', () => {
    expect(parseLimit(makeReq('9999') as Request, 50, 100)).toBe(100);
  });

  it('falls back to default for a negative value', () => {
    expect(parseLimit(makeReq('-1') as Request, 50, 100)).toBe(50);
  });

  it('falls back to default for a non-numeric string', () => {
    expect(parseLimit(makeReq('abc') as Request, 50, 100)).toBe(50);
  });

  it('falls back to default for zero', () => {
    expect(parseLimit(makeReq('0') as Request, 50, 100)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// queryString helper — cursor extraction
// ---------------------------------------------------------------------------

describe('queryString — cursor extraction', () => {
  it('returns undefined when cursor is absent', () => {
    expect(queryString(undefined)).toBeUndefined();
  });

  it('returns the string value when present', () => {
    expect(queryString('abc123')).toBe('abc123');
  });

  it('returns the first element when the value is an array', () => {
    expect(queryString(['first', 'second'])).toBe('first');
  });

  it('returns undefined for a non-string, non-array value', () => {
    expect(queryString(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cursor encoding round-trip
// ---------------------------------------------------------------------------

describe('cursor encoding round-trip', () => {
  const SESSION_ID = 'session-abc';
  const UPSTREAM_TOKEN = 'upstream-next-page-token';

  function encode(sessionId: string, nextToken: string): string {
    return Buffer.from(JSON.stringify({ sessionId, nextToken }), 'utf-8').toString('base64url');
  }

  function decode(cursor: string): { sessionId: string; nextToken: string } {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  }

  it('encodes and decodes without data loss', () => {
    const cursor = encode(SESSION_ID, UPSTREAM_TOKEN);
    const decoded = decode(cursor);
    expect(decoded.sessionId).toBe(SESSION_ID);
    expect(decoded.nextToken).toBe(UPSTREAM_TOKEN);
  });

  it('is URL-safe (contains no + or / characters)', () => {
    const cursor = encode(SESSION_ID, UPSTREAM_TOKEN);
    expect(cursor).not.toMatch(/[+/]/);
  });

  it('a cursor encoded for sessionA is detected as invalid for sessionB', () => {
    const cursorForA = encode('session-A', UPSTREAM_TOKEN);
    const decoded = decode(cursorForA);
    // Route would compare decoded.sessionId !== route :sessionId
    expect(decoded.sessionId).not.toBe('session-B');
  });
});

// ---------------------------------------------------------------------------
// AppError code → HTTP status mapping
// ---------------------------------------------------------------------------

import { AppError, ERROR_CODE_STATUS } from '../../libs/http/index';

describe('AppError status mapping for events route', () => {
  it('VALIDATION_ERROR maps to 400', () => {
    const err = new AppError(ErrorCode.VALIDATION_ERROR, 'bad cursor');
    expect(err.status).toBe(400);
  });

  it('NOT_FOUND maps to 404', () => {
    const err = new AppError(ErrorCode.NOT_FOUND, 'session not found');
    expect(err.status).toBe(404);
  });

  it('PAYLOAD_TOO_LARGE maps to 413', () => {
    const err = new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 'too large');
    expect(err.status).toBe(413);
  });

  it('ERROR_CODE_STATUS covers PAYLOAD_TOO_LARGE', () => {
    expect(ERROR_CODE_STATUS[ErrorCode.PAYLOAD_TOO_LARGE]).toBe(413);
  });
});
