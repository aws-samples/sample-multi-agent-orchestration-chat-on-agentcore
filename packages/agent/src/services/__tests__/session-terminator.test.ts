/**
 * Unit tests for session-terminator: stop URL derivation from the
 * platform-injected AGENTCORE_RUNTIME_URL and the best-effort HTTPS stop call.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockConfig: { AGENTCORE_RUNTIME_URL?: string } = {};
jest.unstable_mockModule('../../config/index.js', () => ({ config: mockConfig }));

const { resolveStopSessionUrl, stopOwnSession } = await import('../session-terminator.js');

const ARN = encodeURIComponent(
  'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/moca-3bl7hC71J7'
);
const BASE = `https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/${ARN}`;
const RUNTIME_URL = `${BASE}/invocations?qualifier=DEFAULT`;
const RUNTIME_SESSION = 'a'.repeat(33) + 'm';

describe('resolveStopSessionUrl', () => {
  it('swaps /invocations for /stopruntimesession and keeps the qualifier', () => {
    expect(resolveStopSessionUrl(RUNTIME_URL)).toBe(`${BASE}/stopruntimesession?qualifier=DEFAULT`);
  });

  it('returns undefined without an invocations URL', () => {
    expect(resolveStopSessionUrl(undefined)).toBeUndefined();
    expect(
      resolveStopSessionUrl('https://bedrock-agentcore.ap-northeast-1.amazonaws.com/ping')
    ).toBeUndefined();
  });
});

describe('stopOwnSession', () => {
  const fetchMock = jest.fn<typeof fetch>();
  const realFetch = global.fetch;

  beforeEach(() => {
    mockConfig.AGENTCORE_RUNTIME_URL = RUNTIME_URL;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts to the stop endpoint with the bearer token and runtime session id', async () => {
    await stopOwnSession(RUNTIME_SESSION, 'Bearer tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/stopruntimesession?qualifier=DEFAULT`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': RUNTIME_SESSION,
    });
  });

  it('skips without a URL or token', async () => {
    await stopOwnSession(RUNTIME_SESSION, undefined);
    mockConfig.AGENTCORE_RUNTIME_URL = undefined;
    await stopOwnSession(RUNTIME_SESSION, 'Bearer tok');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws on an error status or a network failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(stopOwnSession(RUNTIME_SESSION, 'Bearer tok')).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(stopOwnSession(RUNTIME_SESSION, 'Bearer tok')).resolves.toBeUndefined();
  });
});
