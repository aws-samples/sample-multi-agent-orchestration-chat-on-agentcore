/**
 * Stopping a turn is an out-of-band command on the same Runtime session:
 * aborting the streaming fetch would leave the turn running on AgentCore.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentClient } from '../client/agent-client';
import { stopAgentTurn, streamAgentResponse } from '../agent';

vi.mock('../client/agent-client', () => ({ agentClient: { invoke: vi.fn() } }));
vi.mock('../agent-token-renewal', () => ({ startAgentTokenRenewal: () => () => {} }));

const SESSION_ID = 'S'.repeat(33);

beforeEach(() => vi.mocked(agentClient.invoke).mockReset());

describe('stopAgentTurn', () => {
  it('sends { action: "stop" } on the session and reports whether a turn was stopped', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      new Response(JSON.stringify({ type: 'turnStopRequested', stopped: true }), { status: 200 })
    );

    await expect(stopAgentTurn(SESSION_ID)).resolves.toBe(true);

    const request = vi.mocked(agentClient.invoke).mock.calls[0][0] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(request.headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe(SESSION_ID);
    expect(JSON.parse(String(request.body))).toEqual({ action: 'stop' });
  });

  it('reports false when nothing was running', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      new Response(JSON.stringify({ type: 'turnStopRequested', stopped: false }), { status: 200 })
    );
    await expect(stopAgentTurn(SESSION_ID)).resolves.toBe(false);
  });

  it('throws on an HTTP error so the UI can offer a retry', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(new Response('no', { status: 500 }));
    await expect(stopAgentTurn(SESSION_ID)).rejects.toThrow('HTTP 500');
  });
});

describe('streamAgentResponse cancelled turn', () => {
  it('forwards serverCancelledEvent to onCancel, not onComplete or onError', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      new Response(`${JSON.stringify({ type: 'serverCancelledEvent', metadata: {} })}\n`, {
        status: 200,
      })
    );
    const onCancel = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();

    await streamAgentResponse('hi', SESSION_ID, { onCancel, onComplete, onError });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
