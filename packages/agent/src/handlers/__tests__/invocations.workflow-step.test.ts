import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import type { CreateAgentOptions } from '../../runtime/agent/types.js';

const context: Record<string, unknown> = {};
const createAgent = jest.fn<(options: CreateAgentOptions) => Promise<unknown>>();
const streamAgentResponse = jest.fn<() => Promise<unknown>>();
const stopOwnSession = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: () => context,
  requireUserId: () => 'test-user',
  requireIdentityId: () => 'test-identity',
}));
const setupSession = jest.fn<(args: Record<string, unknown>) => Promise<undefined>>();
jest.unstable_mockModule('../../services/session/session-helper.js', () => ({ setupSession }));
jest.unstable_mockModule('../../services/workspace-sync-helper.js', () => ({
  initializeWorkspaceSync: jest.fn(),
  resolveSkillsPaths: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../../services/session-persistence-deps-factory.js', () => ({
  createSessionPersistenceDeps: jest.fn(),
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../stream-handler.js', () => ({ streamAgentResponse }));
jest.unstable_mockModule('../../services/session-terminator.js', () => ({ stopOwnSession }));
const send =
  jest.fn<(command: { constructor: { name: string }; input: unknown }) => Promise<unknown>>();
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

const workflowStep = {
  workflowId: 'wf-1',
  stepId: 'research',
  role: 'worker',
  callbackId: 'cb-1',
};

const assistant = (text: string) => ({
  role: 'assistant',
  content: [{ type: 'textBlock', text }],
});

/** The single callback sent for the turn, decoded. */
function callback() {
  const calls = send.mock.calls.map(([c]) => c);
  expect(calls).toHaveLength(1);
  const { constructor, input } = calls[0] as unknown as {
    constructor: { name: string };
    input: { CallbackId: string; Result?: Uint8Array; Error?: { ErrorMessage: string } };
  };
  return {
    kind: constructor.name,
    callbackId: input.CallbackId,
    result: input.Result ? JSON.parse(new TextDecoder().decode(input.Result)) : undefined,
    error: input.Error?.ErrorMessage,
  };
}

async function invoke(body: Record<string, unknown>) {
  await handleInvocation({ body: { prompt: 'Do it', ...body } } as Request, {} as Response);
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(context)) delete context[key];
  Object.assign(context, { requestId: 'r1', sessionId: undefined, isMachineUser: true });
  createAgent.mockResolvedValue({
    agent: { messages: [assistant('final answer')] },
    metadata: {},
    retryStrategy: {},
  });
  streamAgentResponse.mockResolvedValue({ ok: true });
  send.mockResolvedValue({});
});

describe('workflow step invocations', () => {
  it('injects the submit tool and completes the callback with the final text', async () => {
    await invoke({ workflowStep });

    const options = createAgent.mock.calls[0][0];
    expect(options.additionalTools?.map((t) => t.name)).toEqual(['submit_workflow_result']);
    expect(callback()).toEqual({
      kind: 'SendDurableExecutionCallbackSuccessCommand',
      callbackId: 'cb-1',
      result: { status: 'done', output: 'final answer', implicit: true },
      error: undefined,
    });
    expect(stopOwnSession).not.toHaveBeenCalled(); // sessionless in this test
  });

  it('reports the submitted status with the reply text as output', async () => {
    createAgent.mockImplementation(async (options) => {
      const submit = options.additionalTools![0] as unknown as {
        invoke: (input: unknown) => Promise<unknown>;
      };
      await submit.invoke({ status: 'needs_revision', output: 'meh', feedback: 'cite sources' });
      return { agent: { messages: [assistant('the review')] }, metadata: {}, retryStrategy: {} };
    });
    await invoke({ workflowStep });
    expect(callback().result).toEqual({
      status: 'needs_revision',
      output: 'the review',
      feedback: 'cite sources',
    });
  });

  it('fails the callback when the stream errors', async () => {
    streamAgentResponse.mockResolvedValue({ ok: false, error: 'throttled' });
    await invoke({ workflowStep });
    expect(callback()).toMatchObject({
      kind: 'SendDurableExecutionCallbackFailureCommand',
      error: 'throttled',
    });
  });

  it('fails the callback when the turn throws before streaming', async () => {
    createAgent.mockRejectedValue(new Error('model not enabled'));
    await expect(invoke({ workflowStep })).rejects.toThrow('model not enabled');
    expect(callback()).toMatchObject({
      kind: 'SendDurableExecutionCallbackFailureCommand',
      error: 'model not enabled',
    });
  });

  it('persists step sessions as subagent sessions and releases the microVM', async () => {
    context.sessionId = 'step-session';
    await invoke({ workflowStep });
    expect(setupSession.mock.calls[0][0]).toMatchObject({
      sessionId: 'step-session',
      sessionType: 'subagent',
    });
    expect(stopOwnSession).toHaveBeenCalledWith('step-session');
  });

  it('ignores workflowStep from regular users', async () => {
    context.isMachineUser = false;
    await invoke({ workflowStep });
    expect(createAgent.mock.calls[0][0].additionalTools).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('records agent and model on the context for run_workflow', async () => {
    await invoke({ agentId: 'agent-1', modelId: 'model-1' });
    expect(context).toMatchObject({ agentId: 'agent-1', modelId: 'model-1' });
  });
});
