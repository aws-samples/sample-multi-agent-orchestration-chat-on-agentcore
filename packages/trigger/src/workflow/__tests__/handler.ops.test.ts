import { describe, expect, it, jest } from '@jest/globals';
import type { DurableContext } from '@aws/durable-execution-sdk-js';
import type { WorkflowRecord } from '@moca/tool-definitions';
import { buildOps } from '../handler.js';
import { AgentNotFoundError, type RuntimeClient } from '../runtime-client.js';
import type { WorkflowStore } from '../store.js';

const record: WorkflowRecord = {
  workflowId: 'wf-1',
  userId: 'user-1',
  status: 'running',
  spec: { goal: 'g', steps: [{ id: 's', agentId: 'a', prompt: 'p' }] },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
};
const turn = { stepId: 's', role: 'worker' as const, agentId: 'a', sessionId: 'sess', prompt: 'p' };

/** waitForCallback runs the submitter, then resolves/rejects per the script. */
function fakeCtx(script: Array<string | Error>) {
  const names: string[] = [];
  const waits: string[] = [];
  const ctx = {
    waitForCallback: jest.fn(async (name: string, submit: (id: string) => Promise<void>) => {
      names.push(name);
      await submit(`cb-${names.length}`);
      const next = script.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }),
    wait: jest.fn(async (name: string) => {
      waits.push(name);
    }),
  } as unknown as DurableContext;
  return { ctx, names, waits };
}

function deps() {
  const startTurn = jest.fn<RuntimeClient['startTurn']>().mockResolvedValue({ inProgress: false });
  return {
    startTurn,
    deps: {
      store: {} as WorkflowStore,
      runtime: { startTurn } as unknown as RuntimeClient,
    },
  };
}

describe('buildOps.runAgent', () => {
  it('retries a failed turn once with a new callback, then succeeds', async () => {
    const { ctx, names, waits } = fakeCtx([
      new Error('throttled'),
      JSON.stringify({ status: 'done', output: 'ok' }),
    ]);
    const { deps: d, startTurn } = deps();
    const result = await buildOps(record, d).runAgent(ctx, 's-r1-work0', turn);

    expect(result).toEqual({ status: 'done', output: 'ok' });
    expect(names).toEqual(['s-r1-work0', 's-r1-work0-retry1']);
    expect(waits).toEqual(['s-r1-work0-backoff1']);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(startTurn.mock.calls[1][0].workflowStep?.callbackId).toBe('cb-2');
  });

  it('gives up after the second failure', async () => {
    const { ctx } = fakeCtx([new Error('one'), new Error('two')]);
    await expect(buildOps(record, deps().deps).runAgent(ctx, 'n', turn)).rejects.toThrow('two');
  });

  it('does not retry a missing agent', async () => {
    const { ctx, names } = fakeCtx([new AgentNotFoundError('Agent not found: a')]);
    await expect(buildOps(record, deps().deps).runAgent(ctx, 'n', turn)).rejects.toThrow(
      'Agent not found'
    );
    expect(names).toHaveLength(1);
  });
});
