/**
 * Tests for warmupMiddleware
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { warmupMiddleware } from '../warmup.js';

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
  });

  it('short-circuits with { status: "warm" } when warmup is true', () => {
    warmupMiddleware({ body: { warmup: true } } as any, res, next as any);
    expect(res.json).toHaveBeenCalledWith({ status: 'warm' });
    expect(res.status).not.toHaveBeenCalled();
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
