/**
 * Backend calls from a long turn (AC-7).
 *
 * The request-start JWTs expire after 1 h; Backend calls made later in the
 * turn (sub-agent definition lookup, agent list) must use the freshest tokens
 * renewed for the Runtime session, including from a sub-agent task whose
 * context was reconstructed outside the original request.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../config/index.js', () => ({
  config: { BACKEND_API_URL: 'https://backend.example' },
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { listAgents } = await import('../agent-registry.js');
const { recordSessionTokens, resetSessionTokenStore } =
  await import('../../libs/auth/session-token-store.js');
const { createRequestContext, runWithContext } =
  await import('../../libs/context/request-context.js');

const SESSION = 'S'.repeat(33);
const nowSec = () => Math.floor(Date.now() / 1000);

function jwt(exp: number, tag: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp, tag })}.sig`;
}

const fetchMock = jest.fn<typeof fetch>();

beforeEach(() => {
  resetSessionTokenStore();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ agents: [] }), { status: 200 }));
  globalThis.fetch = fetchMock;
});

function sentHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
}

describe('agent-registry uses renewed tokens', () => {
  const oldAccess = `Bearer ${jwt(nowSec() - 60, 'old')}`;
  const oldId = jwt(nowSec() - 60, 'old-id');
  const newAccess = `Bearer ${jwt(nowSec() + 3600, 'new')}`;
  const newId = jwt(nowSec() + 3600, 'new-id');

  it('prefers the token renewed for the session over the request-start token', async () => {
    const ctx = createRequestContext(oldAccess);
    ctx.idToken = oldId;
    ctx.sessionId = SESSION as never;
    recordSessionTokens(SESSION, { authorizationHeader: newAccess, idToken: newId });

    // Callers pass the request-start tokens explicitly today.
    await runWithContext(ctx, () => listAgents({ authHeader: oldAccess, idToken: oldId }));

    expect(sentHeaders()['Authorization']).toBe(newAccess);
    expect(sentHeaders()['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token']).toBe(newId);
  });

  it('a reconstructed sub-agent context follows the parent session renewals', async () => {
    const ctx = createRequestContext(oldAccess);
    ctx.idToken = oldId;
    ctx.tokenSessionId = SESSION as never; // sub-agent: own sessionId differs
    recordSessionTokens(SESSION, { authorizationHeader: newAccess, idToken: newId });

    await runWithContext(ctx, () => listAgents());

    expect(sentHeaders()['Authorization']).toBe(newAccess);
  });
});
