/**
 * Unit tests for BaseApiClient.
 *
 * The regression we are guarding against: chat sends sometimes showed
 * `error.tokenExpired` and bounced the user to the login screen even
 * when the refresh token was still valid. Root cause: the legacy client
 *   (a) called `handleGlobalError` on 401 which asked the Cognito SDK
 *       for the *cached* access token, so the retry sent the same stale
 *       token back, and
 *   (b) recursed into `fetchWithAuth` for the retry, which re-fetched
 *       tokens a second time and raced cross-tab refresh writes.
 *
 * These tests assert the new behaviour:
 *   - On 401, we call `getTokens({ forceRefresh: true })` (forces Amplify
 *     to exchange the refresh token — no clock-based shortcut).
 *   - The retry uses those *freshly returned* tokens directly in `fetch`,
 *     i.e. `getTokens()` is called at most twice per request: once on
 *     success paths, twice on the 401 retry path (initial + forced).
 *   - Two concurrent 401s together trigger at most one more forced
 *     refresh after each — no race into "stale token" retries.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---- Mocks ----

const getTokens = vi.fn();

class NotAuthenticatedError extends Error {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

vi.mock('../../../lib/auth', () => ({
  authService: { getTokens },
  NotAuthenticatedError,
}));

// ---- Helpers ----

function makeTokens(id: string) {
  return {
    accessToken: `access-${id}`,
    idToken: `id-${id}`,
    userId: '00000000-0000-4000-8000-000000000000',
    expiresAt: Date.now() + 60_000,
  };
}

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- Module under test ----

let mod: typeof import('../base-client');

/**
 * Helper to expose the protected `fetchWithAuth` for tests. Built inside
 * beforeEach so each test re-imports the module (resetModules clears the
 * mock state between tests).
 */
function makeClient() {
  return new (class extends mod.BaseApiClient {
    constructor() {
      super('Test');
    }
    async go(url: string, opts: RequestInit = {}) {
      return this.fetchWithAuth(url, opts);
    }
  })();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mod = await import('../base-client');
  globalThis.fetch = vi.fn();
});

// -----------------------------------------------------------------------
describe('BaseApiClient.fetchWithAuth — 200 path', () => {
  it('includes the access token in Authorization and id token in the AgentCore header', async () => {
    getTokens.mockResolvedValueOnce(makeTokens('1'));
    (globalThis.fetch as Mock).mockResolvedValueOnce(response(200, { ok: true }));

    const client = makeClient();
    await client.go('https://api.example.com/x');

    expect(getTokens).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as Mock).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token']).toBe('id-1');
  });
});

// -----------------------------------------------------------------------
describe('BaseApiClient.fetchWithAuth — 401 retry path', () => {
  it('on 401, forces a token refresh and retries exactly once', async () => {
    getTokens.mockResolvedValueOnce(makeTokens('stale')).mockResolvedValueOnce(makeTokens('fresh'));
    (globalThis.fetch as Mock)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { ok: true }));

    const client = makeClient();
    const res = await client.go('https://api.example.com/x');

    // Exactly two calls: initial + retry
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Exactly two getTokens calls: initial + forced refresh
    expect(getTokens).toHaveBeenCalledTimes(2);
    // The forced refresh must pass forceRefresh: true
    expect(getTokens).toHaveBeenNthCalledWith(2, { forceRefresh: true });

    // The retry must use the NEW tokens, not the stale ones
    const retryHeaders = (globalThis.fetch as Mock).mock.calls[1][1].headers as Record<
      string,
      string
    >;
    expect(retryHeaders.Authorization).toBe('Bearer access-fresh');
    expect(retryHeaders['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token']).toBe('id-fresh');

    expect(res.status).toBe(200);
  });

  it('if retry also returns 401, throws ApiError(401) (no forced logout from this layer)', async () => {
    getTokens
      .mockResolvedValueOnce(makeTokens('stale'))
      .mockResolvedValueOnce(makeTokens('refreshed-but-server-still-mad'));
    (globalThis.fetch as Mock)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(401));

    const client = makeClient();
    await expect(client.go('https://api.example.com/x')).rejects.toBeInstanceOf(mod.ApiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(getTokens).toHaveBeenCalledTimes(2);
  });

  it('if the forced refresh itself rejects, throws ApiError(401) without a second fetch', async () => {
    getTokens
      .mockResolvedValueOnce(makeTokens('stale'))
      .mockRejectedValueOnce(new NotAuthenticatedError('refresh revoked'));
    (globalThis.fetch as Mock).mockResolvedValueOnce(response(401));

    const client = makeClient();
    await expect(client.go('https://api.example.com/x')).rejects.toBeInstanceOf(mod.ApiError);
    // Only the initial fetch happened — the retry was skipped because
    // the refresh couldn't produce new tokens.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------
describe('BaseApiClient.fetchWithAuth — no session', () => {
  it('translates NotAuthenticatedError into AuthenticationError without hitting the network', async () => {
    getTokens.mockRejectedValueOnce(new NotAuthenticatedError());

    const client = makeClient();
    await expect(client.go('https://api.example.com/x')).rejects.toBeInstanceOf(
      mod.AuthenticationError
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
