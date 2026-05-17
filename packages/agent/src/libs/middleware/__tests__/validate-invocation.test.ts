/**
 * Tests for validateInvocationMiddleware
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockValidateImageData = jest.fn<any>().mockReturnValue({ valid: true });

jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
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
});
