import { describe, expect, it } from '@jest/globals';
import {
  WORKFLOW_LIMITS,
  type WorkflowSpec,
  type WorkflowStepResult,
  type WorkflowStepState,
} from '@moca/tool-definitions';
import { runWorkflow, summarize, type AgentTurn, type WorkflowOps } from '../engine.js';

type Responder = (turn: AgentTurn, name: string) => WorkflowStepResult | Error;

/** In-memory ops: steps run inline, map runs items concurrently (Promise.all). */
function fakeOps(respond: Responder, opts: { cancelled?: () => boolean } = {}) {
  const turns: Array<AgentTurn & { name: string }> = [];
  const saved: WorkflowStepState[] = [];
  const stepNames: string[] = [];
  let sessionSeq = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const ops: WorkflowOps<null> = {
    step: async (_c, name, fn) => {
      stepNames.push(name);
      return fn();
    },
    runAgent: async (_c, name, turn) => {
      turns.push({ ...turn, name });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const res = respond(turn, name);
      if (res instanceof Error) throw res;
      return res;
    },
    map: async (_c, _name, items, fn) => Promise.all(items.map((item) => fn(null, item))),
    saveStep: async (s) => {
      saved.push(s);
    },
    isCancelled: async () => opts.cancelled?.() ?? false,
    newSessionId: () => `session-${++sessionSeq}`,
  };
  return { ops, turns, saved, stepNames, maxInFlight: () => maxInFlight };
}

const done = (output: string): WorkflowStepResult => ({ status: 'done', output });

describe('runWorkflow', () => {
  const diamond: WorkflowSpec = {
    goal: 'compare',
    steps: [
      { id: 'a', agentId: 'agent-1', prompt: 'research A' },
      { id: 'b', agentId: 'agent-1', prompt: 'research B' },
      { id: 'report', agentId: 'agent-2', prompt: 'compare {{a.output}}', dependsOn: ['a', 'b'] },
    ],
  };

  it('runs independent steps in parallel and dependants after them', async () => {
    const { ops, turns, maxInFlight } = fakeOps((turn) => done(`out-${turn.stepId}`));
    const result = await runWorkflow(null, 'wf-1', diamond, ops);

    expect(result.status).toBe('completed');
    expect(turns.map((t) => t.stepId)).toEqual(['a', 'b', 'report']);
    expect(maxInFlight()).toBe(2);
    const reportPrompt = turns[2].prompt;
    expect(reportPrompt).toContain('compare out-a'); // template substitution
    expect(reportPrompt).toContain('### b\nout-b'); // upstream section
    expect(result.steps.report.output).toBe('out-report');
    const summary = summarize(diamond, result);
    expect(summary).toContain('Final outputs:\n### report\nout-report');
    expect(summary).toContain('### a\nout-a');
  });

  it('gives every step its own stable session', async () => {
    const { ops, turns } = fakeOps((turn) => done(turn.stepId));
    await runWorkflow(null, 'wf-1', diamond, ops);
    expect(new Set(turns.map((t) => t.sessionId)).size).toBe(3);
  });

  it('loops worker and reviewer until approval, reusing both sessions', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: [
        {
          id: 'draft',
          agentId: 'writer',
          prompt: 'write',
          review: { agentId: 'reviewer', criteria: 'has sources', maxIterations: 3 },
        },
      ],
    };
    let reviews = 0;
    const { ops, turns } = fakeOps((turn) => {
      if (turn.role === 'reviewer') {
        reviews++;
        return reviews < 2
          ? { status: 'needs_revision', output: 'no', feedback: 'add sources' }
          : done('approved');
      }
      return done(`draft v${turns.filter((t) => t.role === 'worker').length}`);
    });
    const result = await runWorkflow(null, 'wf-1', spec, ops);

    expect(turns.map((t) => `${t.role}:${t.name}`)).toEqual([
      'worker:draft-r1-work0',
      'reviewer:draft-r1-review1',
      'worker:draft-r1-work1',
      'reviewer:draft-r1-review2',
    ]);
    expect(turns[2].prompt).toContain('add sources');
    expect(new Set(turns.filter((t) => t.role === 'worker').map((t) => t.sessionId)).size).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.steps.draft).toMatchObject({ output: 'draft v2', status: 'done' });
    expect(result.steps.draft.unapproved).toBeUndefined();
  });

  it('stamps startedAt once per run and keeps it on every later save', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: [
        {
          id: 'draft',
          agentId: 'writer',
          prompt: 'write',
          review: { agentId: 'reviewer', criteria: 'c', maxIterations: 2 },
        },
      ],
    };
    let reviews = 0;
    const { ops, saved } = fakeOps((turn) =>
      turn.role === 'reviewer' && ++reviews < 2
        ? { status: 'needs_revision', output: 'no', feedback: 'fix' }
        : done('ok')
    );
    await runWorkflow(null, 'wf-1', spec, ops);

    const draft = saved.filter((s) => s.stepId === 'draft');
    expect(draft.map((s) => s.status)).toEqual([
      'running',
      'reviewing',
      'running',
      'reviewing',
      'done',
    ]);
    const startedAt = draft[0].startedAt;
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(draft.every((s) => s.startedAt === startedAt)).toBe(true);
  });

  it('accepts the last output as unapproved when maxIterations is exhausted', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: [
        {
          id: 's',
          agentId: 'w',
          prompt: 'p',
          review: { agentId: 'r', criteria: 'c', maxIterations: 1 },
        },
      ],
    };
    const { ops, turns } = fakeOps((turn) =>
      turn.role === 'reviewer'
        ? { status: 'needs_revision', output: 'x', feedback: 'fix' }
        : done('v')
    );
    const result = await runWorkflow(null, 'wf-1', spec, ops);
    expect(turns).toHaveLength(2);
    expect(result.steps.s).toMatchObject({ status: 'done', unapproved: true, feedback: 'fix' });
    expect(summarize(spec, result)).toContain('review not approved');
  });

  it('re-runs the upstream step with downstream feedback, then the dependant', async () => {
    let reportRuns = 0;
    const { ops, turns } = fakeOps((turn) => {
      if (turn.stepId === 'report') {
        reportRuns++;
        return reportRuns === 1
          ? { status: 'blocked', output: '', feedback: 'A lacks prices', targetStepId: 'a' }
          : done('final');
      }
      return done(`out-${turn.stepId}-${turns.filter((t) => t.stepId === turn.stepId).length}`);
    });
    const result = await runWorkflow(null, 'wf-1', diamond, ops);

    expect(result.status).toBe('completed');
    expect(result.escalations).toBe(1);
    expect(turns.map((t) => t.name)).toEqual([
      'a-r1-work0',
      'b-r1-work0',
      'report-r1-work0',
      'a-r2-work0',
      'report-r2-work0',
    ]);
    expect(turns[3].prompt).toContain('A lacks prices');
    expect(turns[4].prompt).toContain('Upstream outputs changed');
    expect(turns[4].prompt).toContain('out-a-2');
    expect(result.steps.b.runs).toBe(1); // untouched sibling is not redone
  });

  it('merges same-wave escalations to one upstream into a single re-run', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: [
        { id: 'research', agentId: 'r', prompt: 'research' },
        { id: 'write_a', agentId: 'w', prompt: 'a', dependsOn: ['research'] },
        { id: 'write_b', agentId: 'w', prompt: 'b', dependsOn: ['research'] },
      ],
    };
    const runs: Record<string, number> = {};
    const { ops, turns } = fakeOps((turn) => {
      runs[turn.stepId] = (runs[turn.stepId] ?? 0) + 1;
      if (turn.stepId !== 'research' && runs[turn.stepId] === 1) {
        return {
          status: 'blocked',
          output: '',
          feedback: `need more for ${turn.stepId}`,
          targetStepId: 'research',
        };
      }
      return done(turn.stepId);
    });
    const result = await runWorkflow(null, 'wf-1', spec, ops);

    expect(result.status).toBe('completed');
    expect(result.escalations).toBe(1);
    expect(runs.research).toBe(2);
    const rerun = turns.filter((t) => t.stepId === 'research')[1].prompt;
    expect(rerun).toContain('need more for write_a');
    expect(rerun).toContain('need more for write_b');
  });

  it('fails a blocked step whose target is not an upstream step', async () => {
    const { ops } = fakeOps((turn) =>
      turn.stepId === 'report'
        ? { status: 'blocked', output: '', feedback: 'x', targetStepId: 'report' }
        : done('ok')
    );
    const result = await runWorkflow(null, 'wf-1', diamond, ops);
    expect(result.status).toBe('failed');
    expect(result.steps.report.error).toContain('valid upstream');
  });

  it('stops escalating once the budget is used up', async () => {
    const { ops } = fakeOps((turn) =>
      turn.stepId === 'report'
        ? { status: 'blocked', output: '', feedback: 'again', targetStepId: 'a' }
        : done('ok')
    );
    const result = await runWorkflow(null, 'wf-1', diamond, ops);
    expect(result.escalations).toBe(3);
    expect(result.status).toBe('failed');
    expect(result.steps.report.error).toContain('escalation budget');
  });

  it('skips dependants of a failed step but finishes independent branches', async () => {
    const { ops, turns, saved } = fakeOps((turn) =>
      turn.stepId === 'a' ? new Error('model exploded') : done('ok')
    );
    const result = await runWorkflow(null, 'wf-1', diamond, ops);
    expect(result.status).toBe('failed');
    expect(result.steps.a).toMatchObject({ status: 'failed', error: 'model exploded' });
    expect(result.steps.b.status).toBe('done');
    expect(result.steps.report.status).toBe('skipped');
    expect(turns.map((t) => t.stepId)).toEqual(['a', 'b']);
    expect(saved.some((s) => s.stepId === 'report' && s.status === 'skipped')).toBe(true);
  });

  it('fails a step that reports failure and skips its dependants', async () => {
    const { ops, turns } = fakeOps((turn) =>
      turn.stepId === 'a'
        ? { status: 'failed', output: 'exit 1', feedback: 'command exited 1' }
        : done(turn.stepId)
    );
    const result = await runWorkflow(null, 'wf-1', diamond, ops);

    expect(result.status).toBe('failed');
    expect(result.steps.a.status).toBe('failed');
    expect(result.steps.a.error).toContain('command exited 1');
    expect(result.steps.b.status).toBe('done');
    expect(result.steps.report.status).toBe('skipped');
    // Not retried: the step's own verdict is final.
    expect(turns.filter((t) => t.stepId === 'a')).toHaveLength(1);
  });

  it('fails the step when its reviewer reports failure instead of sending it back', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: [
        { id: 'a', agentId: 'w', prompt: 'p', review: { agentId: 'r', criteria: 'c' } },
        { id: 'b', agentId: 'w', prompt: 'p', dependsOn: ['a'] },
      ],
    };
    const { ops, turns } = fakeOps((turn) =>
      turn.role === 'reviewer'
        ? { status: 'failed', output: '', feedback: 'Workspace conflict: x' }
        : done(turn.stepId)
    );
    const result = await runWorkflow(null, 'wf-1', spec, ops);

    expect(result.steps.a.status).toBe('failed');
    expect(result.steps.a.error).toContain('Workspace conflict');
    expect(result.steps.b.status).toBe('skipped');
    expect(turns.filter((t) => t.stepId === 'a' && t.role === 'worker')).toHaveLength(1);
  });

  it('runs the reviewer with its own modelId', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: [
        {
          id: 'a',
          agentId: 'w',
          prompt: 'p',
          modelId: 'worker-model',
          review: { agentId: 'r', criteria: 'c', modelId: 'reviewer-model' },
        },
      ],
    };
    const { ops, turns } = fakeOps((turn) => done(turn.stepId));
    await runWorkflow(null, 'wf-1', spec, ops);
    expect(turns.map((t) => [t.role, t.modelId])).toEqual([
      ['worker', 'worker-model'],
      ['reviewer', 'reviewer-model'],
    ]);
  });

  it('tells workers how to report failure', async () => {
    const { ops, turns } = fakeOps((turn) => done(turn.stepId));
    await runWorkflow(null, 'wf-1', diamond, ops);
    expect(turns[0].prompt).toContain('status "failed"');
  });

  it('stops before the next wave when cancelled', async () => {
    let cancelled = false;
    const { ops, turns } = fakeOps((turn) => {
      cancelled = true;
      return done(turn.stepId);
    });
    const result = await runWorkflow(null, 'wf-1', diamond, {
      ...ops,
      isCancelled: async () => cancelled,
    });
    expect(result.status).toBe('cancelled');
    expect(turns.map((t) => t.stepId)).toEqual(['a', 'b']);
    expect(result.steps.report.status).toBe('cancelled');
  });

  it('keeps the summary within MAX_SUMMARY_LENGTH for large final outputs', async () => {
    const spec: WorkflowSpec = {
      goal: 'g',
      steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, agentId: 'a', prompt: 'p' })),
    };
    const { ops } = fakeOps(() => done('x'.repeat(20_000)));
    const summary = summarize(spec, await runWorkflow(null, 'wf-1', spec, ops));
    expect(summary.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.MAX_SUMMARY_LENGTH + 1);
    expect(summary).toContain('### s5');
  });

  it('uses unique, deterministic durable operation names', async () => {
    const { ops, stepNames } = fakeOps((turn) => done(turn.stepId));
    await runWorkflow(null, 'wf-1', diamond, ops);
    // Child-context names (r1-start) repeat across steps but carry the step id.
    expect(new Set(stepNames).size).toBe(stepNames.length);
  });
});
