/**
 * Unit tests for stopDispatchMiddleware.
 *
 * A `{ action: 'stop' }` invocation is an out-of-band cancel command: it must
 * short-circuit BEFORE prompt validation / identity exchange / streaming, look
 * up the in-flight Agent for the authenticated sessionId, cancel it, and return
 * a small JSON ack. Any other body falls through to the normal chain.
 *
 * Uses jest.unstable_mockModule so the registry can be observed without a real
 * Agent.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockCancelAgent = jest.fn<(sessionId: string) => boolean>();

jest.unstable_mockModule('../../health/agent-cancel-registry.js', () => ({
  cancelAgent: mockCancelAgent,
}));
jest.unstable_mockModule('../../logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetCurrentContext = jest.fn<() => { sessionId?: string; requestId?: string } | undefined>();
jest.unstable_mockModule('../../context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
}));

const { stopDispatchMiddleware } = await import('../stop-dispatch.js');

function createRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function (this: any, payload: unknown) {
      this.body = payload;
      return this;
    }),
  };
  return res;
}

describe('stopDispatchMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentContext.mockReturnValue({ sessionId: 'sess-1', requestId: 'req-1' });
  });

  it('passes through (calls next) for a normal prompt request', () => {
    const req: any = { body: { prompt: 'hello' } };
    const res = createRes();
    const next = jest.fn();

    stopDispatchMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(mockCancelAgent).not.toHaveBeenCalled();
  });

  it('cancels the session and acks (200) for action:stop, without calling next', () => {
    mockCancelAgent.mockReturnValue(true);
    const req: any = { body: { action: 'stop' } };
    const res = createRes();
    const next = jest.fn();

    stopDispatchMiddleware(req, res, next);

    expect(mockCancelAgent).toHaveBeenCalledWith('sess-1');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'cancelled', cancelled: true });
  });

  it('reports cancelled:false when no turn was in flight (still 200)', () => {
    mockCancelAgent.mockReturnValue(false);
    const req: any = { body: { action: 'stop' } };
    const res = createRes();
    const next = jest.fn();

    stopDispatchMiddleware(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'not_running', cancelled: false });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a stop with no sessionId (400) rather than cancelling blindly', () => {
    mockGetCurrentContext.mockReturnValue({ requestId: 'req-1' }); // no sessionId
    const req: any = { body: { action: 'stop' } };
    const res = createRes();
    const next = jest.fn();

    stopDispatchMiddleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(mockCancelAgent).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
