/**
 * The orchestrator handler run through the real durable SDK
 * (LocalDurableTestRunner): checkpoints, replay on every callback, map,
 * waits and callbacks behave as on Lambda. Only the Runtime client and the
 * DynamoDB store are replaced.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import type {
  WorkflowRecord,
  WorkflowSpec,
  WorkflowStepResult,
  WorkflowStepState,
} from '@moca/tool-definitions';

// ── fakes ──────────────────────────────────────────────────────────────────

type Turn = {
  sessionId: string;
  agentId: string;
  prompt: string;
  sessionType: string;
  workflowStep?: { stepId: string; role: string; callbackId: string };
};
const turns: Turn[] = [];
let parentInProgress = 0;
const stopped: string[] = [];

class FakeRuntimeClient {
  async startTurn(params: Turn) {
    turns.push(params);
    if (!params.workflowStep && parentInProgress > 0) {
      parentInProgress -= 1;
      return { inProgress: true };
    }
    return { inProgress: false };
  }
  async stopSession(sessionId: string) {
    stopped.push(sessionId);
    return { ok: true, status: 200 };
  }
}

const headers = new Map<string, WorkflowRecord>();
const stepStates = new Map<string, WorkflowStepState>();
const statusLog: string[] = [];

class FakeStore {
  static fromEnvironment() {
    return new FakeStore();
  }
  async get(_u: string, id: string) {
    const h = headers.get(id);
    return h ? structuredClone(h) : null;
  }
  async listSteps(_u: string, id: string) {
    return [...stepStates.values()].filter((s) => s.workflowId === id).map((s) => ({ ...s }));
  }
  async saveStep(_u: string, state: WorkflowStepState) {
    const key = `${state.workflowId}#${state.stepId}`;
    if (stepStates.get(key)?.status === 'cancelled') return;
    stepStates.set(key, { ...state });
  }
  async setStatus(_u: string, id: string, status: WorkflowRecord['status'], fields = {}) {
    const h = headers.get(id)!;
    if (h.status === 'cancelled') return;
    headers.set(id, { ...h, status, ...fields });
    statusLog.push(status);
  }
}

jest.unstable_mockModule('../runtime-client.js', () => ({
  RuntimeClient: FakeRuntimeClient,
  AgentNotFoundError: class AgentNotFoundError extends Error {},
}));
jest.unstable_mockModule('../store.js', () => ({ WorkflowStore: FakeStore }));
jest.unstable_mockModule('../../services/auth-service.js', () => ({
  AuthService: { fromEnvironment: () => ({}) },
}));
jest.unstable_mockModule('../../services/agents-service.js', () => ({
  createAgentsService: () => ({}),
}));
type Execution = { DurableExecutionArn: string; DurableExecutionName: string; Status: string };
let executions: Execution[] = [];
const stoppedExecutions: string[] = [];
jest.unstable_mockModule('@aws-sdk/client-lambda', () => {
  class ListDurableExecutionsByFunctionCommand {
    constructor(public input: unknown) {}
  }
  class StopDurableExecutionCommand {
    constructor(public input: { DurableExecutionArn: string }) {}
  }
  return {
    LambdaClient: class {
      async send(command: unknown) {
        if (command instanceof StopDurableExecutionCommand) {
          stoppedExecutions.push(command.input.DurableExecutionArn);
          return {};
        }
        return { DurableExecutions: executions };
      }
    },
    ListDurableExecutionsByFunctionCommand,
    StopDurableExecutionCommand,
  };
});

process.env.AGENT_API_URL = 'https://runtime.example/invocations';
const { handler } = await import('../handler.js');

// ── helpers ────────────────────────────────────────────────────────────────

const done = (output: string): WorkflowStepResult => ({ status: 'done', output });

function seed(spec: WorkflowSpec, parent?: WorkflowRecord['parent']): WorkflowRecord {
  const record: WorkflowRecord = {
    workflowId: 'wf-1',
    userId: 'user-1',
    status: 'pending',
    spec,
    parent,
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
  };
  headers.set('wf-1', record);
  return record;
}

/** Answer the callback named `name` once its submitter (startTurn) has run. */
async function respond(
  runner: LocalDurableTestRunner,
  name: string,
  result: WorkflowStepResult | Error
) {
  const op = await runner.getOperation(name).waitForData(WaitingOperationStatus.SUBMITTED);
  if (result instanceof Error) {
    await op.sendCallbackFailure({ ErrorType: 'StepFailed', ErrorMessage: result.message });
  } else {
    await op.sendCallbackSuccess(JSON.stringify(result));
  }
}

const runEvent = { action: 'run', workflowId: 'wf-1', userId: 'user-1' };

beforeAll(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }));
afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

beforeEach(() => {
  turns.length = 0;
  stopped.length = 0;
  statusLog.length = 0;
  parentInProgress = 0;
  executions = [];
  stoppedExecutions.length = 0;
  headers.clear();
  stepStates.clear();
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('orchestrator handler (durable)', () => {
  const diamond: WorkflowSpec = {
    goal: 'compare',
    notifyOnComplete: false,
    steps: [
      { id: 'a', agentId: 'agent', prompt: 'research A' },
      { id: 'b', agentId: 'agent', prompt: 'research B' },
      {
        id: 'report',
        agentId: 'agent',
        prompt: 'compare',
        dependsOn: ['a', 'b'],
        review: { agentId: 'reviewer', criteria: 'cites sources', maxIterations: 2 },
      },
    ],
  };

  it('runs parallel steps, then the dependant through a review revision', async () => {
    seed(diamond);
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    await Promise.all([
      respond(runner, 'a-r1-work0', done('out-a')),
      respond(runner, 'b-r1-work0', done('out-b')),
    ]);
    await respond(runner, 'report-r1-work0', done('draft 1'));
    await respond(runner, 'report-r1-review1', {
      status: 'needs_revision',
      output: 'no',
      feedback: 'add sources',
    });
    await respond(runner, 'report-r1-work1', done('draft 2'));
    await respond(runner, 'report-r1-review2', done('approved'));
    const result = await execution;

    expect(result.getStatus()).toBe('SUCCEEDED');
    expect(result.getResult()).toEqual({ workflowId: 'wf-1', status: 'completed' });
    expect(headers.get('wf-1')?.status).toBe('completed');
    expect(stepStates.get('wf-1#report')).toMatchObject({ status: 'done', output: 'draft 2' });

    // Replay must not start any turn twice: one startTurn per callback.
    const keys = turns.map((t) => `${t.workflowStep?.stepId}:${t.workflowStep?.role}`);
    expect(keys.sort()).toEqual(
      [
        'a:worker',
        'b:worker',
        'report:reviewer',
        'report:reviewer',
        'report:worker',
        'report:worker',
      ].sort()
    );
    expect(new Set(turns.map((t) => t.workflowStep?.callbackId)).size).toBe(turns.length);
    // Each step keeps one session across rounds, including after replays.
    const reportWorker = turns.filter(
      (t) => t.workflowStep?.stepId === 'report' && t.workflowStep.role === 'worker'
    );
    expect(reportWorker[0].sessionId).toBe(reportWorker[1].sessionId);
    expect(reportWorker[1].prompt).toContain('add sources');
  });

  it('retries a failed turn with a new callback and continues', async () => {
    seed({
      goal: 'g',
      notifyOnComplete: false,
      steps: [{ id: 's', agentId: 'agent', prompt: 'p' }],
    });
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    await respond(runner, 's-r1-work0', new Error('ThrottlingException'));
    await respond(runner, 's-r1-work0-retry1', done('ok'));
    const result = await execution;

    expect(result.getResult()).toEqual({ workflowId: 'wf-1', status: 'completed' });
    expect(turns).toHaveLength(2);
    expect(turns[0].sessionId).toBe(turns[1].sessionId);
    expect(runner.getOperation('s-r1-work0-backoff1').getWaitDetails()).toBeDefined();
  });

  it('lets a sibling finish when a parallel step fails, then skips dependants', async () => {
    seed(diamond);
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    await Promise.all([
      (async () => {
        await respond(runner, 'a-r1-work0', new Error('boom'));
        await respond(runner, 'a-r1-work0-retry1', new Error('boom again'));
      })(),
      respond(runner, 'b-r1-work0', done('out-b')),
    ]);
    const result = await execution;

    expect(result.getResult()).toEqual({ workflowId: 'wf-1', status: 'failed' });
    expect(stepStates.get('wf-1#a')).toMatchObject({ status: 'failed' });
    expect(stepStates.get('wf-1#b')).toMatchObject({ status: 'done', output: 'out-b' });
    expect(stepStates.get('wf-1#report')?.status).toBe('skipped');
    expect(headers.get('wf-1')?.result).toContain('a (agent): failed');
  });

  it('re-runs the upstream step when a downstream step is blocked', async () => {
    seed({
      goal: 'g',
      notifyOnComplete: false,
      steps: [
        { id: 'fact', agentId: 'agent', prompt: 'a fact' },
        { id: 'headline', agentId: 'agent', prompt: 'a headline', dependsOn: ['fact'] },
      ],
    });
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    await respond(runner, 'fact-r1-work0', done('no number'));
    await respond(runner, 'headline-r1-work0', {
      status: 'blocked',
      output: '',
      feedback: 'include a number',
      targetStepId: 'fact',
    });
    await respond(runner, 'fact-r2-work0', done('2 moons'));
    await respond(runner, 'headline-r2-work0', done('2 MOONS'));
    const result = await execution;

    expect(result.getResult()).toEqual({ workflowId: 'wf-1', status: 'completed' });
    const factTurns = turns.filter((t) => t.workflowStep?.stepId === 'fact');
    expect(factTurns[1].prompt).toContain('include a number');
    expect(stepStates.get('wf-1#fact')).toMatchObject({ runs: 2, output: '2 moons' });
  });

  it('stops before the next wave once cancel is requested', async () => {
    seed(diamond);
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    // Both steps of the first wave are running when the user cancels.
    const [a, b] = await Promise.all(
      ['a-r1-work0', 'b-r1-work0'].map((n) =>
        runner.getOperation(n).waitForData(WaitingOperationStatus.SUBMITTED)
      )
    );
    headers.set('wf-1', { ...headers.get('wf-1')!, cancelRequested: true });
    await a.sendCallbackSuccess(JSON.stringify(done('out-a')));
    await b.sendCallbackSuccess(JSON.stringify(done('out-b')));
    const result = await execution;

    expect(result.getResult()).toEqual({ workflowId: 'wf-1', status: 'cancelled' });
    expect(turns.map((t) => t.workflowStep?.stepId).sort()).toEqual(['a', 'b']);
    expect(stepStates.get('wf-1#report')?.status).toBe('cancelled');
  });

  it('resumes the parent session, waiting while it has a turn in progress', async () => {
    seed(
      { ...diamond, notifyOnComplete: true, steps: [{ id: 's', agentId: 'agent', prompt: 'p' }] },
      {
        sessionId: 'parent-session',
        agentId: 'parent-agent',
        sessionType: 'user',
        storagePath: '/x',
      }
    );
    parentInProgress = 2;
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    await respond(runner, 's-r1-work0', done('the result'));
    const result = await execution;

    expect(result.getResult()).toEqual({ workflowId: 'wf-1', status: 'completed' });
    const notifications = turns.filter((t) => !t.workflowStep);
    expect(notifications).toHaveLength(3);
    expect(notifications[2]).toMatchObject({
      sessionId: 'parent-session',
      agentId: 'parent-agent',
      sessionType: 'user',
    });
    expect(notifications[2].prompt).toContain('[Workflow finished]');
    expect(notifications[2].prompt).toContain('the result');
  });

  it('does not notify without a parent agent', async () => {
    seed(
      { ...diamond, notifyOnComplete: true, steps: [{ id: 's', agentId: 'agent', prompt: 'p' }] },
      {
        sessionId: 'parent-session',
      }
    );
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = runner.run({ payload: runEvent });
    await respond(runner, 's-r1-work0', done('x'));
    await execution;
    expect(turns.filter((t) => !t.workflowStep)).toHaveLength(0);
  });

  it('cancel action stops only the matching execution and the running step sessions', async () => {
    seed(diamond);
    headers.set('wf-1', { ...headers.get('wf-1')!, status: 'running' });
    stepStates.set('wf-1#a', {
      workflowId: 'wf-1',
      stepId: 'a',
      status: 'running',
      runs: 1,
      iteration: 0,
      sessionId: 'sess-a',
      updatedAt: '',
    });
    stepStates.set('wf-1#report', {
      workflowId: 'wf-1',
      stepId: 'report',
      status: 'pending',
      runs: 0,
      iteration: 0,
      updatedAt: '',
    });
    executions = [
      { DurableExecutionArn: 'arn:cancel', DurableExecutionName: 'wf-1-cancel', Status: 'RUNNING' },
      { DurableExecutionArn: 'arn:main', DurableExecutionName: 'wf-1', Status: 'RUNNING' },
      { DurableExecutionArn: 'arn:old', DurableExecutionName: 'wf-1', Status: 'SUCCEEDED' },
    ];
    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const result = await runner.run({
      payload: { action: 'cancel', workflowId: 'wf-1', userId: 'user-1' },
    });

    expect(result.getStatus()).toBe('SUCCEEDED');
    expect(stoppedExecutions).toEqual(['arn:main']);
    expect(stopped).toEqual(['sess-a']);
    expect(stepStates.get('wf-1#a')?.status).toBe('cancelled');
    expect(stepStates.get('wf-1#report')?.status).toBe('cancelled');
    expect(headers.get('wf-1')?.status).toBe('cancelled');
  });
});
