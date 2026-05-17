/**
 * Error Handler Tests
 * Tests that the global Express error handler returns 400 for JSON parse errors
 * and 500 for other unhandled errors.
 *
 * The handler logic is extracted and tested directly without an HTTP server,
 * following the same pattern as auth.test.ts.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Inline replication of the error handler from src/index.ts
// so we can unit-test it without booting the full server.
// ---------------------------------------------------------------------------
function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Helpers to build mock req / res objects
// ---------------------------------------------------------------------------
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    path: '/test',
    method: 'POST',
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  let capturedStatus = 0;
  let capturedBody: unknown = {};

  const res = {
    get _status() {
      return capturedStatus;
    },
    get _body() {
      return capturedBody;
    },
    status(code: number) {
      capturedStatus = code;
      return res;
    },
    json(body: unknown) {
      capturedBody = body;
      return res;
    },
  };

  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('errorHandler - JSON SyntaxError', () => {
  it('returns 400 when express.json() throws SyntaxError with body property', () => {
    const syntaxErr = Object.assign(new SyntaxError('Unexpected token'), { body: '{ bad' });
    const req = mockReq();
    const res = mockRes();

    errorHandler(syntaxErr, req, res as unknown as Response, jest.fn() as unknown as NextFunction);

    expect(res._status).toBe(400);
    expect((res._body as Record<string, string>).error).toBe('Bad Request');
    expect((res._body as Record<string, string>).message).toBe('Invalid JSON in request body');
  });

  it('returns 400 for SyntaxError with any truthy body value', () => {
    const syntaxErr = Object.assign(new SyntaxError('Unexpected end'), { body: undefined });
    // body must be present as an own property (the 'in' operator checks own+prototype)
    Object.defineProperty(syntaxErr, 'body', { value: '', enumerable: true });
    const res = mockRes();

    errorHandler(
      syntaxErr,
      mockReq(),
      res as unknown as Response,
      jest.fn() as unknown as NextFunction
    );

    expect(res._status).toBe(400);
  });

  it('returns 500 for a SyntaxError that has no body property', () => {
    const syntaxErr = new SyntaxError('eval syntax error');
    const res = mockRes();

    errorHandler(
      syntaxErr,
      mockReq(),
      res as unknown as Response,
      jest.fn() as unknown as NextFunction
    );

    // No 'body' property → not a JSON parse error → falls through to 500
    expect(res._status).toBe(500);
    expect((res._body as Record<string, string>).error).toBe('Internal Server Error');
  });
});

describe('errorHandler - generic errors', () => {
  it('returns 500 for a plain Error', () => {
    const err = new Error('something exploded');
    const res = mockRes();

    errorHandler(err, mockReq(), res as unknown as Response, jest.fn() as unknown as NextFunction);

    expect(res._status).toBe(500);
    expect((res._body as Record<string, string>).error).toBe('Internal Server Error');
    expect((res._body as Record<string, string>).message).toBe('something exploded');
  });

  it('returns 500 for a TypeError', () => {
    const err = new TypeError('cannot read property');
    const res = mockRes();

    errorHandler(err, mockReq(), res as unknown as Response, jest.fn() as unknown as NextFunction);

    expect(res._status).toBe(500);
  });
});
