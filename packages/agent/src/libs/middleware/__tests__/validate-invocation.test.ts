/**
 * Tests for validateInvocationMiddleware
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockValidateImageData = jest.fn<any>().mockReturnValue({ valid: true });

const mockConfig: { BEDROCK_MODEL_IDS?: string } = {};
jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: mockConfig,
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

  describe('modelId', () => {
    const body = (modelId: string) => ({ body: { prompt: 'hi', modelId } }) as any;

    it('accepts a deployment model under any cross-region prefix', () => {
      mockConfig.BEDROCK_MODEL_IDS = 'global.anthropic.claude-sonnet-4-6,openai.gpt-oss-120b-1:0';
      validateInvocationMiddleware(body('jp.anthropic.claude-sonnet-4-6'), res, next as any);
      expect(next).toHaveBeenCalled();
    });

    it('rejects a model outside the deployment', () => {
      mockConfig.BEDROCK_MODEL_IDS = 'global.anthropic.claude-sonnet-4-6';
      validateInvocationMiddleware(body('global.anthropic.claude-opus-5-5'), res, next as any);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a non-string modelId with 400 instead of crashing', () => {
      validateInvocationMiddleware(
        { body: { prompt: 'hi', modelId: 42 } } as any,
        res,
        next as any
      );
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it.each([null, ''])('treats %p as "use the default model"', (modelId) => {
      mockConfig.BEDROCK_MODEL_IDS = 'global.anthropic.claude-sonnet-4-6';
      validateInvocationMiddleware({ body: { prompt: 'hi', modelId } } as any, res, next as any);
      expect(next).toHaveBeenCalled();
    });
  });
});
