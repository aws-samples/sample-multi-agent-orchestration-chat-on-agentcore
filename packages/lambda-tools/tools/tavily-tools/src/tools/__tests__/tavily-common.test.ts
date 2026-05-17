// Stub out Secrets Manager so no network/AWS call is attempted during `callTavilyApi`
// tests. The SDK client is instantiated at module load in `tavily-common.ts`, so the
// mock must be hoisted (i.e. declared at file top-level before the import).
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
  callTavilyApi,
  formatTavilyApiError,
  normalizeTavilyImage,
  __resetApiKeyCacheForTests,
} from '../tavily-common.js';

describe('formatTavilyApiError', () => {
  it('uses `error` string when present', () => {
    expect(formatTavilyApiError('search', 400, { error: 'bad query' })).toBe(
      'Tavily search API error (400): bad query'
    );
  });

  it('falls through when `error` is a nested object (regression: [object Object])', () => {
    // Regression: earlier implementation emitted "[object Object]" because it
    // accepted non-string values for `error`.
    const body = { error: { code: 'validation', details: ['too long'] } };
    expect(formatTavilyApiError('extract', 400, body)).toBe(
      `Tavily extract API error (400): ${JSON.stringify(body)}`
    );
  });

  it('uses `detail` when `error` is missing', () => {
    expect(formatTavilyApiError('crawl', 422, { detail: 'field required' })).toBe(
      'Tavily crawl API error (422): field required'
    );
  });

  it('uses `message` as a later fallback', () => {
    expect(formatTavilyApiError('search', 429, { message: 'rate limited' })).toBe(
      'Tavily search API error (429): rate limited'
    );
  });

  it('uses `code` when no human message is available', () => {
    expect(formatTavilyApiError('search', 500, { code: 'ERR_INTERNAL' })).toBe(
      'Tavily search API error (500): ERR_INTERNAL'
    );
  });

  it('stringifies the whole body when no known string field is present', () => {
    const body = { something: 'else', status: 'fail' };
    expect(formatTavilyApiError('search', 500, body)).toBe(
      `Tavily search API error (500): ${JSON.stringify(body)}`
    );
  });

  it('handles non-object bodies (e.g. plain string)', () => {
    expect(formatTavilyApiError('search', 502, 'Bad Gateway')).toBe(
      'Tavily search API error (502): Bad Gateway'
    );
  });

  it('handles null/undefined bodies', () => {
    expect(formatTavilyApiError('search', 504, null)).toBe(
      'Tavily search API error (504): <no response body>'
    );
    expect(formatTavilyApiError('search', 504, undefined)).toBe(
      'Tavily search API error (504): <no response body>'
    );
  });

  it('skips empty string fields and falls through', () => {
    // An empty-string `error` should not be treated as a valid reason
    const body = { error: '', detail: 'actual detail' };
    expect(formatTavilyApiError('search', 400, body)).toBe(
      'Tavily search API error (400): actual detail'
    );
  });
});

describe('callTavilyApi', () => {
  const originalFetch = globalThis.fetch;
  const originalSecretName = process.env.TAVILY_API_KEY_SECRET_NAME;

  beforeEach(() => {
    // Provide a dummy secret name; the SecretsManagerClient is mocked below so no
    // real AWS call is made, but `getTavilyApiKey` checks the env var first.
    process.env.TAVILY_API_KEY_SECRET_NAME = 'test-secret';
    __resetApiKeyCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecretName === undefined) {
      delete process.env.TAVILY_API_KEY_SECRET_NAME;
    } else {
      process.env.TAVILY_API_KEY_SECRET_NAME = originalSecretName;
    }
    jest.restoreAllMocks();
  });

  function mockFetch(response: Partial<Response>): jest.Mock {
    const fn = jest.fn().mockResolvedValue(response as Response);
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('POSTs to the correct endpoint URL with bearer auth and JSON body', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: async () => ({ query: 'foo', results: [] }),
    });

    await callTavilyApi<{ query: string }>('search', { query: 'foo' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(init.body as string)).toEqual({ query: 'foo' });
  });

  it('returns the decoded JSON body on success', async () => {
    mockFetch({
      ok: true,
      json: async () => ({ base_url: 'https://example.com', results: [{ url: 'a' }] }),
    });

    const result = await callTavilyApi<{ base_url: string; results: { url: string }[] }>('crawl', {
      url: 'https://example.com',
    });

    expect(result.base_url).toBe('https://example.com');
    expect(result.results).toHaveLength(1);
  });

  it('throws with formatTavilyApiError-formatted message on non-ok response', async () => {
    mockFetch({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ message: 'rate limited' }),
    });

    await expect(callTavilyApi('extract', {})).rejects.toThrow(
      'Tavily extract API error (429): rate limited'
    );
  });

  it('falls back to status/statusText message when error body is not JSON', async () => {
    mockFetch({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(callTavilyApi('search', {})).rejects.toThrow(
      'Tavily search API error (502 Bad Gateway)'
    );
  });
});

describe('normalizeTavilyImage', () => {
  it('wraps a plain URL string into { url }', () => {
    // Default Tavily response shape (include_image_descriptions=false):
    // images come back as bare URL strings.
    expect(normalizeTavilyImage('https://example.com/a.png')).toEqual({
      url: 'https://example.com/a.png',
    });
  });

  it('passes through a { url, description } object unchanged', () => {
    expect(
      normalizeTavilyImage({ url: 'https://example.com/a.png', description: 'a cat' })
    ).toEqual({ url: 'https://example.com/a.png', description: 'a cat' });
  });

  it('returns { url } when description is absent on object entry', () => {
    expect(normalizeTavilyImage({ url: 'https://example.com/a.png' })).toEqual({
      url: 'https://example.com/a.png',
    });
  });

  it('returns null for empty string (so caller can skip the row)', () => {
    expect(normalizeTavilyImage('')).toBeNull();
  });

  it('returns null for object with missing url (regression: "undefined" rows)', () => {
    // Regression: previously the formatter dereferenced `.url` on a string
    // entry or url-less object, emitting literal "undefined" in the output.
    expect(normalizeTavilyImage({})).toBeNull();
    expect(normalizeTavilyImage({ description: 'desc only' })).toBeNull();
    expect(normalizeTavilyImage({ url: '' })).toBeNull();
  });

  it('returns null for null/undefined entries', () => {
    expect(normalizeTavilyImage(null)).toBeNull();
    expect(normalizeTavilyImage(undefined)).toBeNull();
  });
});
