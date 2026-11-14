import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AgentNotFoundError, RuntimeClient } from '../runtime-client.js';
import type { AuthService } from '../../services/auth-service.js';
import type { AgentsService } from '../../services/agents-service.js';

const URL_ =
  'https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/arn:aws:bedrock-agentcore:ap-northeast-1:1:runtime/rt-1/invocations?qualifier=DEFAULT';

function client(
  agent: unknown = {
    systemPrompt: 'sp',
    enabledTools: ['call_agent', 'run_workflow', 'file_editor'],
  }
) {
  const auth = {
    getMachineUserToken: jest.fn(async () => ({
      accessToken: 'm-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    })),
    getOpenIdTokenForUser: jest.fn(async () => ({ openIdToken: 'oid', identityId: 'id' })),
  } as unknown as AuthService;
  const agents = { getAgent: jest.fn(async () => agent) } as unknown as AgentsService;
  return { rc: new RuntimeClient(auth, agents, URL_), auth };
}

function ndjson(lines: string[]): Response {
  return new Response(lines.map((l) => `${l}\n`).join(''), { status: 200 });
}

const params = {
  userId: 'u',
  sessionId: 's',
  sessionType: 'subagent',
  agentId: 'a',
  prompt: 'p',
  workflowStep: { workflowId: 'wf', stepId: 'st', role: 'worker' as const, callbackId: 'cb' },
};

let fetchMock: jest.Mock<typeof fetch>;
beforeEach(() => {
  fetchMock = jest.fn<typeof fetch>();
  global.fetch = fetchMock;
});
afterEach(() => jest.useRealTimers());

describe('RuntimeClient.startTurn', () => {
  it('sends the step with nested-workflow tools removed and the ARN encoded', async () => {
    fetchMock.mockResolvedValue(ndjson(['{"type":"messageStart"}']));
    const { rc } = client();
    await expect(rc.startTurn(params)).resolves.toEqual({ inProgress: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/runtimes/arn%3Aaws%3Abedrock-agentcore');
    const body = JSON.parse(String(init!.body));
    expect(body.enabledTools).toEqual(['file_editor']);
    expect(body.workflowStep.callbackId).toBe('cb');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer m-token');
    expect(headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token']).toBe('oid');
  });

  it('keeps the agent tools for a non-step (parent) turn', async () => {
    fetchMock.mockResolvedValue(ndjson(['{}']));
    const { rc } = client();
    await rc.startTurn({ ...params, workflowStep: undefined });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).enabledTools).toContain(
      'run_workflow'
    );
  });

  it('reports a turn already in progress on the session', async () => {
    fetchMock.mockResolvedValue(ndjson(['{"type":"serverTurnInProgressEvent","turn":{}}']));
    await expect(client().rc.startTurn(params)).resolves.toEqual({ inProgress: true });
  });

  it('throws on an HTTP error and for a missing agent', async () => {
    fetchMock.mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(client().rc.startTurn(params)).rejects.toThrow('Agent API returned 403');
    await expect(client(null).rc.startTurn(params)).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it('gives up when the Runtime sends no response headers', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
        )
    );
    const pending = client().rc.startTurn(params);
    const assertion = expect(pending).rejects.toThrow(/No response headers within 120000 ms/);
    await jest.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it('reuses the machine token across turns', async () => {
    fetchMock.mockImplementation(async () => ndjson(['{}']));
    const { rc, auth } = client();
    await rc.startTurn(params);
    await rc.startTurn(params);
    expect(auth.getMachineUserToken).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeClient.stopSession', () => {
  it('calls stopruntimesession with the bearer token and session header', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(client().rc.stopSession('sess-1')).resolves.toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/stopruntimesession\?qualifier=DEFAULT$/);
    expect(
      (init!.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']
    ).toBe('sess-1');
  });
});
