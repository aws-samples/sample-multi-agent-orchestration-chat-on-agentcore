/**
 * Tests for validateInvocationMiddleware
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockValidateImageData = jest.fn<any>().mockReturnValue({ valid: true });

jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
  GOAL_LOOP_ATTEMPTS_MIN: 1,
  GOAL_LOOP_ATTEMPTS_MAX: 10,
}));

jest.unstable_mockModule('../../../types/index.js', () => ({
  validateImageData: mockValidateImageData,
}));

const { validateInvocationMiddleware } = await import('../validate-invocation.js');

function createMockResponse() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('validateInvocationMiddleware', () => {
  let next: jest.Mock;
  let res: any;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    res = createMockResponse();
    mockValidateImageData.mockReturnValue({ valid: true });
  });

  it('returns 400 when body is missing', () => {
    validateInvocationMiddleware({ body: undefined } as any, res, next as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Request body is required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for empty prompt', () => {
    validateInvocationMiddleware({ body: { prompt: '' } } as any, res, next as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Empty prompt provided' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for whitespace-only prompt', () => {
    validateInvocationMiddleware({ body: { prompt: '   ' } } as any, res, next as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for undefined prompt with no images', () => {
    validateInvocationMiddleware({ body: {} } as any, res, next as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Empty prompt provided' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows empty prompt when images are provided', () => {
    const images = [{ base64: 'abc', mimeType: 'image/png' }];
    validateInvocationMiddleware({ body: { prompt: '', images } } as any, res, next as any);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 400 when image validation fails', () => {
    mockValidateImageData.mockReturnValue({ valid: false, error: 'Invalid image format' });
    const images = [{ base64: 'bad', mimeType: 'image/png' }];
    validateInvocationMiddleware(
      { body: { prompt: 'Describe this', images } } as any,
      res,
      next as any
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid image format' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when body is valid', () => {
    validateInvocationMiddleware({ body: { prompt: 'Hello' } } as any, res, next as any);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('goal normalization', () => {
    it('trims the goal in place', () => {
      const body: any = { prompt: 'p', goal: '  be concise  ' };
      validateInvocationMiddleware({ body } as any, res, next as any);
      expect(body.goal).toBe('be concise');
      expect(next).toHaveBeenCalled();
    });

    it('drops a whitespace-only goal', () => {
      const body: any = { prompt: 'p', goal: '   ' };
      validateInvocationMiddleware({ body } as any, res, next as any);
      expect(body.goal).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('rejects an over-long goal with 400 instead of silently truncating', () => {
      // Truncation could cut a NL criterion mid-sentence (e.g. before a
      // negation) and invert its meaning — fail loud like the other checks.
      const body: any = { prompt: 'p', goal: 'x'.repeat(4001) };
      validateInvocationMiddleware({ body } as any, res, next as any);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts a goal at exactly the maximum length', () => {
      const body: any = { prompt: 'p', goal: 'x'.repeat(4000) };
      validateInvocationMiddleware({ body } as any, res, next as any);
      expect(body.goal).toHaveLength(4000);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('goalMaxAttempts normalization', () => {
    it('keeps an in-range integer as-is', () => {
      const body: any = { prompt: 'p', goalMaxAttempts: 5 };
      validateInvocationMiddleware({ body } as any, res, next as any);
      expect(body.goalMaxAttempts).toBe(5);
      expect(next).toHaveBeenCalled();
    });

    it('clamps out-of-range integers', () => {
      const low: any = { prompt: 'p', goalMaxAttempts: 0 };
      validateInvocationMiddleware({ body: low } as any, res, next as any);
      expect(low.goalMaxAttempts).toBe(1);

      const high: any = { prompt: 'p', goalMaxAttempts: 100 };
      validateInvocationMiddleware({ body: high } as any, res, next as any);
      expect(high.goalMaxAttempts).toBe(10);
    });

    it('drops non-integer values (agent falls back to the default)', () => {
      for (const bad of [2.5, NaN, 'three', null, {}]) {
        const body: any = { prompt: 'p', goalMaxAttempts: bad };
        validateInvocationMiddleware({ body } as any, res, next as any);
        expect(body.goalMaxAttempts).toBeUndefined();
      }
    });

    it('leaves an absent goalMaxAttempts untouched', () => {
      const body: any = { prompt: 'p' };
      validateInvocationMiddleware({ body } as any, res, next as any);
      expect('goalMaxAttempts' in body).toBe(false);
    });
  });
});
