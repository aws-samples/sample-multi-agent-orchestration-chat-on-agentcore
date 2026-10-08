/**
 * Tests for warmupMiddleware
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const prefetchWorkspaceSync = jest.fn<(...args: unknown[]) => Promise<void>>();
const beginInvocation = jest.fn();
const endInvocation = jest.fn();

jest.unstable_mockModule('../../../services/workspace-sync-helper.js', () => ({
  prefetchWorkspaceSync,
}));
jest.unstable_mockModule('../../context/request-context.js', () => ({
  requireUserId: () => 'user-1',
}));
jest.unstable_mockModule('../../health/in-flight.js', () => ({
  beginInvocation,
  endInvocation,
}));
jest.unstable_mockModule('../../logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { warmupMiddleware } = await import('../warmup.js');

function createMockResponse() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('warmupMiddleware', () => {
  let next: jest.Mock;
  let res: any;

  beforeEach(() => {
    next = jest.fn();
    res = createMockResponse();
    prefetchWorkspaceSync.mockReset();
    beginInvocation.mockReset();
    endInvocation.mockReset();
  });

  it('short-circuits with { status: "warm" } when warmup is true', () => {
    warmupMiddleware({ body: { warmup: true } } as any, res, next as any);
    expect(res.json).toHaveBeenCalledWith({ status: 'warm' });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(prefetchWorkspaceSync).not.toHaveBeenCalled();
  });

  it('starts a workspace prefetch and stays busy until it settles', async () => {
    let finishPrefetch!: () => void;
    prefetchWorkspaceSync.mockReturnValue(new Promise<void>((r) => (finishPrefetch = r)));

    warmupMiddleware({ body: { warmup: true, storagePath: '/project' } } as any, res, next as any);

    expect(prefetchWorkspaceSync).toHaveBeenCalledWith('user-1', '/project');
    expect(res.json).toHaveBeenCalledWith({ status: 'warm' });
    expect(beginInvocation).toHaveBeenCalledTimes(1);
    expect(endInvocation).not.toHaveBeenCalled();

    finishPrefetch();
    await new Promise((r) => setImmediate(r));
    expect(endInvocation).toHaveBeenCalledTimes(1);
  });

  it('still answers warm when the prefetch throws', () => {
    prefetchWorkspaceSync.mockImplementation(() => {
      throw new Error('invalid storage path');
    });
    warmupMiddleware({ body: { warmup: true, storagePath: '../x' } } as any, res, next as any);
    expect(res.json).toHaveBeenCalledWith({ status: 'warm' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through a normal invocation', () => {
    warmupMiddleware({ body: { prompt: 'hello' } } as any, res, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('passes through when warmup is not strictly true', () => {
    warmupMiddleware({ body: { warmup: 'true' } } as any, res, next as any);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes through when body is missing', () => {
    warmupMiddleware({ body: undefined } as any, res, next as any);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
