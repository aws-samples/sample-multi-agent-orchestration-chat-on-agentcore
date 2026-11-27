/**
 * A conversation whose plain runtime session id is pinned to the machine user
 * (created by automation before runtime session ids were split) continues on
 * the rescued runtime session.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import {
  invokeOnRuntimeSession,
  registerRescuedLookup,
  resetRuntimeSessions,
  runtimeSessionIdFor,
} from '../runtime-session';

vi.mock('../client/agent-client', () => ({ agentClient: { invoke: vi.fn() } }));

const SESSION = 'S'.repeat(33);

const pinned = () =>
  new Response('{"message":"Access denied."}', {
    status: 403,
    headers: { 'x-amzn-ErrorType': 'AccessDeniedException:http://internal.amazon.com/coral/x/' },
  });
const ok = () => new Response('{}', { status: 200 });
const sentIds = () =>
  vi
    .mocked(agentClient.invoke)
    .mock.calls.map(
      ([init]) =>
        (init!.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']
    );

beforeEach(() => {
  vi.clearAllMocks();
  resetRuntimeSessions();
});

describe('invokeOnRuntimeSession', () => {
  it('uses the plain conversation id and keeps other headers', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(ok());
    await invokeOnRuntimeSession(SESSION, { headers: { 'Content-Type': 'application/json' } });
    expect(sentIds()).toEqual([SESSION]);
    expect(vi.mocked(agentClient.invoke).mock.calls[0][0]!.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
  });

  it('retries once on the rescued runtime session and remembers it on success', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValueOnce(pinned()).mockResolvedValueOnce(ok());
    const response = await invokeOnRuntimeSession(SESSION, {});
    expect(response.status).toBe(200);
    expect(sentIds()).toEqual([SESSION, `${SESSION}u`]);
    expect(runtimeSessionIdFor(SESSION)).toBe(`${SESSION}u`);
  });

  it('does not remember a rescue that failed', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValueOnce(pinned()).mockResolvedValueOnce(pinned());
    const response = await invokeOnRuntimeSession(SESSION, {});
    expect(response.status).toBe(403);
    expect(sentIds()).toHaveLength(2);
    expect(runtimeSessionIdFor(SESSION)).toBe(SESSION);
  });

  it('does not retry other 403s', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(new Response('{}', { status: 403 }));
    await invokeOnRuntimeSession(SESSION, {});
    expect(sentIds()).toEqual([SESSION]);
  });

  it('starts on the rescued runtime session when the session row says so', async () => {
    registerRescuedLookup((id) => id === SESSION);
    vi.mocked(agentClient.invoke).mockResolvedValue(pinned());
    await invokeOnRuntimeSession(SESSION, {});
    expect(sentIds()).toEqual([`${SESSION}u`]);
  });

  it('never suffixes an id that is not a conversation id', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(pinned());
    await invokeOnRuntimeSession('short', {});
    expect(sentIds()).toEqual(['short']);
  });
});
