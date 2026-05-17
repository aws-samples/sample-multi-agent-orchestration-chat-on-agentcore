/**
 * Tests for authResolverMiddleware
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockResolveEffectiveUserId = jest.fn<any>();
const mockGetCurrentContext = jest.fn<any>();

jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));

jest.unstable_mockModule('../../auth/index.js', () => ({
  resolveEffectiveUserId: mockResolveEffectiveUserId,
}));

jest.unstable_mockModule('../../context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
}));

const { authResolverMiddleware } = await import('../auth-resolver.js');

function createMockResponse() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('authResolverMiddleware', () => {
  let next: jest.Mock;
  let res: any;
  let ctx: any;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    res = createMockResponse();
    // Mirror the shape produced by `createRequestContext` — `storagePath`
    // is seeded to `'/'` at context creation so downstream code can rely
    // on it being populated without a fallback.
    ctx = {
      requestId: 'req-1',
      startTime: new Date(),
      isMachineUser: false,
      storagePath: '/',
    };
    mockGetCurrentContext.mockReturnValue(ctx);
    mockResolveEffectiveUserId.mockReturnValue({ userId: 'resolved-user' });
  });

  it('returns 500 when RequestContext is not initialized', () => {
    mockGetCurrentContext.mockReturnValue(undefined);

    authResolverMiddleware({ body: {} } as any, res, next as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('enriches context and calls next on success', () => {
    authResolverMiddleware(
      { body: { prompt: 'Hi', storagePath: '/my/path' } } as any,
      res,
      next as any
    );

    expect(ctx.userId).toBe('resolved-user');
    expect(ctx.storagePath).toBe('/my/path');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('keeps storagePath as "/" (seeded by createRequestContext) when body does not specify one', () => {
    authResolverMiddleware({ body: { prompt: 'Hi' } } as any, res, next as any);

    expect(ctx.storagePath).toBe('/');
    expect(next).toHaveBeenCalled();
  });

  it('responds with the error status from resolveEffectiveUserId', () => {
    mockResolveEffectiveUserId.mockReturnValue({
      userId: '',
      error: { status: 403, message: 'Forbidden' },
    });

    authResolverMiddleware({ body: { prompt: 'Hi' } } as any, res, next as any);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes targetUserId from body to resolveEffectiveUserId', () => {
    authResolverMiddleware(
      { body: { prompt: 'Hi', targetUserId: 'tgt' } } as any,
      res,
      next as any
    );

    expect(mockResolveEffectiveUserId).toHaveBeenCalledWith(ctx, 'tgt');
  });

  it('handles missing body gracefully', () => {
    authResolverMiddleware({ body: undefined } as any, res, next as any);

    // Should still attempt resolution (no body means no targetUserId)
    expect(mockResolveEffectiveUserId).toHaveBeenCalledWith(ctx, undefined);
  });
});
