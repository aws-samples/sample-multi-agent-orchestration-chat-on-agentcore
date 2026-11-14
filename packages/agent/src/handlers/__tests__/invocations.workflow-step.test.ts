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
const initializeWorkspaceSync = jest.fn<() => unknown>();
jest.unstable_mockModule('../../services/workspace-sync-helper.js', () => ({
  initializeWorkspaceSync,
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
  initializeWorkspaceSync.mockReset();
  stopOwnSession.mockReset();
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

  it('asks the step once more when it finished without reply text', async () => {
    const messages: unknown[] = [{ role: 'user', content: [{ type: 'textBlock', text: 'Do it' }] }];
    const invokeFollowUp = jest.fn(async () => {
      messages.push(
        { role: 'user', content: [{ type: 'textBlock', text: 'follow-up' }] },
        assistant('recovered')
      );
    });
    createAgent.mockResolvedValue({
      agent: { messages, invoke: invokeFollowUp },
      metadata: {},
      retryStrategy: {},
    });

    await invoke({ workflowStep });

    expect(invokeFollowUp).toHaveBeenCalledTimes(1);
    expect(callback().result).toMatchObject({ status: 'done', output: 'recovered' });
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
    await invoke({ workflowStep: { ...workflowStep, parentSessionId: 'parent-1', goal: 'G' } });
    expect(setupSession.mock.calls[0][0]).toMatchObject({
      sessionId: 'step-session',
      sessionType: 'subagent',
      parent: {
        sessionId: 'parent-1',
        workflowId: 'wf-1',
        workflowGoal: 'G',
        stepId: 'research',
        role: 'worker',
      },
    });
    expect(stopOwnSession).toHaveBeenCalledWith('step-session');
  });

  it('flushes the workspace to S3 before completing the callback and stopping the session', async () => {
    const order: string[] = [];
    const syncToS3 = jest.fn(async () => {
      order.push('sync');
      return { success: true };
    });
    const takeConflicts = jest.fn(async () => []);
    initializeWorkspaceSync.mockReturnValue({
      workspaceSync: { syncToS3, takeConflicts },
      hook: {},
    });
    send.mockImplementation(async () => {
      order.push('callback');
      return {};
    });
    stopOwnSession.mockImplementation(async () => {
      order.push('stop');
    });
    context.sessionId = 'step-session';

    await invoke({ workflowStep, storagePath: '/project' });

    expect(order).toEqual(['sync', 'callback', 'stop']);
  });

  it('fails a done step on conflicts found by any push of the turn, not as a callback failure', async () => {
    const syncToS3 = jest.fn(async () => ({ success: true }));
    // The conflict came from an earlier hook push; the final push saw nothing.
    const takeConflicts = jest.fn(async () => [
      { path: 'shared.txt', savedAs: 'shared (conflict x).txt' },
    ]);
    initializeWorkspaceSync.mockReturnValue({
      workspaceSync: { syncToS3, takeConflicts },
      hook: {},
    });

    await invoke({ workflowStep, storagePath: '/project' });

    const cb = callback();
    expect(cb.kind).toBe('SendDurableExecutionCallbackSuccessCommand');
    expect(cb.result).toMatchObject({
      status: 'failed',
      output: 'final answer',
      feedback: expect.stringContaining('shared (conflict x).txt'),
    });
  });

  it("keeps a reviewer's approval despite conflicts", async () => {
    const takeConflicts = jest.fn(async () => [{ path: 'coverage.json' }]);
    initializeWorkspaceSync.mockReturnValue({
      workspaceSync: { syncToS3: jest.fn(async () => ({ success: true })), takeConflicts },
      hook: {},
    });

    await invoke({ workflowStep: { ...workflowStep, role: 'reviewer' }, storagePath: '/project' });

    expect(callback().result).toMatchObject({ status: 'done' });
  });

  it('keeps a blocked submission despite conflicts so the upstream redo still happens', async () => {
    createAgent.mockImplementation(async (options) => {
      const submit = options.additionalTools![0] as unknown as {
        invoke: (input: unknown) => Promise<unknown>;
      };
      await submit.invoke({ status: 'blocked', feedback: 'bad input', targetStepId: 'fetch' });
      return {
        agent: { messages: [assistant('cannot proceed')] },
        metadata: {},
        retryStrategy: {},
      };
    });
    const takeConflicts = jest.fn(async () => [{ path: 'shared.txt' }]);
    initializeWorkspaceSync.mockReturnValue({
      workspaceSync: { syncToS3: jest.fn(async () => ({ success: true })), takeConflicts },
      hook: {},
    });

    await invoke({ workflowStep, storagePath: '/project' });

    expect(callback().result).toMatchObject({ status: 'blocked', targetStepId: 'fetch' });
  });

  it('still completes the callback when the final sync throws', async () => {
    const syncToS3 = jest.fn(async () => {
      throw new Error('no credentials');
    });
    const takeConflicts = jest.fn(async () => []);
    initializeWorkspaceSync.mockReturnValue({
      workspaceSync: { syncToS3, takeConflicts },
      hook: {},
    });

    await invoke({ workflowStep, storagePath: '/project' });

    expect(callback().kind).toBe('SendDurableExecutionCallbackSuccessCommand');
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
