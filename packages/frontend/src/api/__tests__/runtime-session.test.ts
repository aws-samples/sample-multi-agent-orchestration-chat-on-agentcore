import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { invokeOnRuntimeSession, runtimeSessionIdFor } from '../runtime-session';

vi.mock('../client/agent-client', () => ({ agentClient: { invoke: vi.fn() } }));

const SESSION = 'S'.repeat(33);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentClient.invoke).mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('runtimeSessionIdFor', () => {
  it('uses the user runtime session of a conversation', () => {
    expect(runtimeSessionIdFor(SESSION)).toBe(`${SESSION}u`);
  });

  it('never suffixes an id that is not a conversation id', () => {
    expect(runtimeSessionIdFor('short')).toBe('short');
  });
});

describe('invokeOnRuntimeSession', () => {
  it('sends once on the user runtime session and keeps other headers', async () => {
    await invokeOnRuntimeSession(SESSION, { headers: { 'Content-Type': 'application/json' } });
    expect(agentClient.invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentClient.invoke).mock.calls[0][0]!.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': `${SESSION}u`,
    });
  });

  it('does not retry on a 403', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(new Response('{}', { status: 403 }));
    const response = await invokeOnRuntimeSession(SESSION, {});
    expect(response.status).toBe(403);
    expect(agentClient.invoke).toHaveBeenCalledTimes(1);
  });
});
