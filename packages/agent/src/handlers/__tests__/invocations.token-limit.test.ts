/**
 * /invocations with monthly token limits on: the pre-turn refusal (structured
 * event, no agent, event sessions still stopped) and draining usage before the
 * microVM is stopped or a workflow step reports back.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const order: string[] = [];
const context: Record<string, unknown> = {};
const createAgent = jest.fn<() => Promise<unknown>>();
const streamAgentResponse = jest.fn<() => Promise<unknown>>();
const stopOwnSession = jest.fn(async () => {
  order.push('stopOwnSession');
});
const checkTokenLimit = jest.fn<() => Promise<unknown>>();
const drainUsage = jest.fn(async () => {
  order.push('drainUsage');
});
const send = jest.fn(async (_command: { constructor: { name: string } }) => {
  order.push('callback');
  return {};
});

jest.unstable_mockModule('../../config/index.js', () => ({
  config: {
    TOKEN_LIMITS_ENABLED: true,
    BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-6',
    AWS_REGION: 'ap-northeast-1',
  },
}));
jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCallerAuthorizationHeader: () => undefined,
  getCallerIdToken: () => undefined,
  getCurrentContext: () => context,
  requireUserId: () => 'test-user',
  requireIdentityId: () => 'test-identity',
}));
jest.unstable_mockModule('../../services/session/session-helper.js', () => ({
  setupSession: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../../services/workspace-sync-helper.js', () => ({
  initializeWorkspaceSync: jest.fn(),
  resolveSkillsPaths: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/session-persistence-deps-factory.js', () => ({
  createSessionPersistenceDeps: jest.fn(),
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../stream-handler.js', () => ({ streamAgentResponse }));
jest.unstable_mockModule('../../services/session-terminator.js', () => ({ stopOwnSession }));
jest.unstable_mockModule('../../services/usage/limit-check.js', () => ({ checkTokenLimit }));
jest.unstable_mockModule('../../services/usage/usage-recorder.js', () => ({ drainUsage }));
jest.unstable_mockModule('@aws-sdk/client-lambda', () => {
  const command = (name: string) =>
    ({
      [name]: class {
        constructor(public input: unknown) {}
      },
    })[name];
  return {
    LambdaClient: class {
      send = send;
    },
    SendDurableExecutionCallbackSuccessCommand: command(
      'SendDurableExecutionCallbackSuccessCommand'
    ),
    SendDurableExecutionCallbackFailureCommand: command(
      'SendDurableExecutionCallbackFailureCommand'
    ),
    SendDurableExecutionCallbackHeartbeatCommand: command(
      'SendDurableExecutionCallbackHeartbeatCommand'
    ),
  };
});

const { handleInvocation } = await import('../invocations.js');

function mockResponse() {
  const written: string[] = [];
  const res = {
    setHeader: jest.fn(),
    write: jest.fn((chunk: string) => written.push(chunk)),
    end: jest.fn(),
  };
  return { res: res as unknown as Response, written, raw: res };
}

const refusal = {
  modelKey: 'anthropic.claude-sonnet-4-6',
  dimension: 'output',
  used: 3000,
  limit: 3000,
  resetsAt: '2026-11-30T15:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  for (const key of Object.keys(context)) delete context[key];
  Object.assign(context, { requestId: 'r1', sessionId: undefined, sessionType: undefined });
  createAgent.mockResolvedValue({
    agent: { messages: [{ role: 'assistant', content: [{ type: 'textBlock', text: 'ok' }] }] },
    metadata: {},
    retryStrategy: {},
  });
  streamAgentResponse.mockResolvedValue({ ok: true });
  checkTokenLimit.mockResolvedValue(undefined);
});

describe('pre-turn refusal', () => {
  it('writes a structured tokenLimitExceeded event and never creates the agent', async () => {
    checkTokenLimit.mockResolvedValue(refusal);
    const { res, written, raw } = mockResponse();
    await handleInvocation({ body: { prompt: 'hi' } } as Request, res);
    expect(createAgent).not.toHaveBeenCalled();
    expect(raw.end).toHaveBeenCalled();
    const event = JSON.parse(written.join(''));
    expect(event).toEqual({
      type: 'serverErrorEvent',
      error: expect.objectContaining({
        code: 'tokenLimitExceeded',
        savedToHistory: false,
        ...refusal,
      }),
    });
  });

  it('checks the default model when the body has none', async () => {
    await handleInvocation({ body: { prompt: 'hi' } } as Request, mockResponse().res);
    expect(checkTokenLimit).toHaveBeenCalledWith(context, 'global.anthropic.claude-sonnet-4-6');
  });

  // Regression: the refusal returned before the event-session cleanup.
  it('still stops the microVM of a refused trigger (event) turn', async () => {
    checkTokenLimit.mockResolvedValue(refusal);
    Object.assign(context, { sessionId: 'sess-1', sessionType: 'event' });
    await handleInvocation({ body: { prompt: 'hi' } } as Request, mockResponse().res);
    expect(stopOwnSession).toHaveBeenCalledWith('sess-1');
  });

  it('leaves the pre-check to the agent for workflow steps', async () => {
    Object.assign(context, { isMachineUser: true });
    await handleInvocation(
      {
        body: {
          prompt: 'hi',
          workflowStep: { workflowId: 'wf', stepId: 's', role: 'worker', callbackId: 'cb' },
        },
      } as Request,
      mockResponse().res
    );
    expect(checkTokenLimit).not.toHaveBeenCalled();
  });
});

describe('draining usage before the microVM goes away', () => {
  it('drains before stopping an event session', async () => {
    Object.assign(context, { sessionId: 'sess-1', sessionType: 'event' });
    await handleInvocation({ body: { prompt: 'hi' } } as Request, mockResponse().res);
    expect(order).toEqual(['drainUsage', 'stopOwnSession']);
  });

  it('drains before a workflow step reports back', async () => {
    Object.assign(context, { isMachineUser: true });
    await handleInvocation(
      {
        body: {
          prompt: 'hi',
          workflowStep: { workflowId: 'wf', stepId: 's', role: 'worker', callbackId: 'cb' },
        },
      } as Request,
      mockResponse().res
    );
    expect(order.indexOf('drainUsage')).toBeLessThan(order.indexOf('callback'));
  });

  it('does not wait for usage on interactive chat turns', async () => {
    Object.assign(context, { sessionId: 'sess-1', sessionType: undefined });
    await handleInvocation({ body: { prompt: 'hi' } } as Request, mockResponse().res);
    expect(drainUsage).not.toHaveBeenCalled();
  });
});

describe('workflow steps stopped by the limit', () => {
  const step = { workflowId: 'wf', stepId: 's', role: 'worker', callbackId: 'cb' };

  // Regression: the stop message was reported as a successful deliverable.
  it('reports the step as failed when the hook stopped the turn', async () => {
    Object.assign(context, { isMachineUser: true });
    streamAgentResponse.mockImplementation(async () => {
      context.tokenLimitStopped = { code: 'tokenLimitReached', message: 'limit reached' };
      return { ok: true };
    });
    await handleInvocation(
      { body: { prompt: 'hi', workflowStep: step } } as Request,
      mockResponse().res
    );
    const commands = send.mock.calls.map(([c]) => c.constructor.name);
    expect(commands).toContain('SendDurableExecutionCallbackFailureCommand');
    expect(commands).not.toContain('SendDurableExecutionCallbackSuccessCommand');
  });

  it('reports success when the limit did not interfere', async () => {
    Object.assign(context, { isMachineUser: true });
    await handleInvocation(
      { body: { prompt: 'hi', workflowStep: step } } as Request,
      mockResponse().res
    );
    expect(send.mock.calls.map(([c]) => c.constructor.name)).toContain(
      'SendDurableExecutionCallbackSuccessCommand'
    );
  });
});
