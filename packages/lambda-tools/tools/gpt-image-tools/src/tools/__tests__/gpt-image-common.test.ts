// Stub out Secrets Manager so no network/AWS call is attempted. The SDK client
// is instantiated at module load in `gpt-image-common.ts`, so the mock must be
// hoisted (declared at file top-level before the import).
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send(): Promise<{ SecretString: string }> {
      return { SecretString: 'dummy-api-key' };
    }
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import {
  formatOpenAiApiError,
  getOpenAiApiKey,
  __resetApiKeyCacheForTests,
} from '../gpt-image-common.js';

describe('formatOpenAiApiError', () => {
  it('uses the nested `error.message` (OpenAI canonical shape)', () => {
    const body = { error: { message: 'Invalid size', type: 'invalid_request_error', code: null } };
    expect(formatOpenAiApiError(400, body)).toBe('OpenAI Images API error (400): Invalid size');
  });

  it('uses a top-level string `error` when not an object', () => {
    expect(formatOpenAiApiError(401, { error: 'Incorrect API key' })).toBe(
      'OpenAI Images API error (401): Incorrect API key'
    );
  });

  it('uses `message` as a later fallback', () => {
    expect(formatOpenAiApiError(429, { message: 'rate limited' })).toBe(
      'OpenAI Images API error (429): rate limited'
    );
  });

  it('stringifies the whole body when no known string field is present', () => {
    const body = { something: 'else', status: 'fail' };
    expect(formatOpenAiApiError(500, body)).toBe(
      `OpenAI Images API error (500): ${JSON.stringify(body)}`
    );
  });

  it('does not emit [object Object] when nested error lacks a string message', () => {
    // Regression guard: nested error object with a non-string message must fall
    // through to JSON.stringify rather than coercing the object to a string.
    const body = { error: { message: { nested: true } } };
    expect(formatOpenAiApiError(400, body)).toBe(
      `OpenAI Images API error (400): ${JSON.stringify(body)}`
    );
  });

  it('handles a null body', () => {
    expect(formatOpenAiApiError(502, null)).toBe(
      'OpenAI Images API error (502): <no response body>'
    );
  });

  it('flags moderation_blocked distinctly with a do-not-retry hint', () => {
    const body = {
      error: {
        message: 'Your request was rejected as a result of our safety system.',
        type: 'image_generation_user_error',
        code: 'moderation_blocked',
      },
    };
    const msg = formatOpenAiApiError(400, body);
    expect(msg).toContain('content moderation blocked');
    expect(msg).toContain('do not retry');
    expect(msg).toContain('safety system');
  });
});

describe('getOpenAiApiKey', () => {
  beforeEach(() => {
    __resetApiKeyCacheForTests();
    delete process.env.OPENAI_API_KEY_SECRET_NAME;
  });

  it('rejects when OPENAI_API_KEY_SECRET_NAME is not set', async () => {
    await expect(getOpenAiApiKey()).rejects.toThrow('OPENAI_API_KEY_SECRET_NAME');
  });

  it('resolves the secret value when the env var is set', async () => {
    process.env.OPENAI_API_KEY_SECRET_NAME = 'agentcore/default/openai-api-key';
    await expect(getOpenAiApiKey()).resolves.toBe('dummy-api-key');
  });
});
