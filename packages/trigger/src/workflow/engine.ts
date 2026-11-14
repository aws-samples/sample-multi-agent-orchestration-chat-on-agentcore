/**
 * Workflow scheduling logic, independent of the durable runtime.
 *
 * Execution proceeds in waves: every pending step whose dependencies are done
 * runs in parallel, then outcomes are applied. Waves (instead of launching a
 * step the moment it becomes ready) keep the control flow a pure function of
 * prior operation results, which durable replay requires, and make
 * downstream→upstream escalation a simple state reset between waves.
 */

import {
  WORKFLOW_LIMITS,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepResult,
  type WorkflowStepRole,
  type WorkflowStepState,
  type WorkflowStepStatus,
} from '@moca/tool-definitions';
import {
  ancestorsOf,
  buildReviewerPrompt,
  buildWorkerPrompt,
  type WorkerRunReason,
} from './prompts.js';

export interface AgentTurn {
  stepId: string;
  role: WorkflowStepRole;
  agentId: string;
  sessionId: string;
  prompt: string;
  modelId?: string;
}

/** Durable primitives the engine needs; `C` is the (child) durable context. */
export interface WorkflowOps<C> {
  step<T>(ctx: C, name: string, fn: () => Promise<T>): Promise<T>;
  /** Run one agent turn and wait for its result. Throws when the turn fails. */
  runAgent(ctx: C, name: string, turn: AgentTurn): Promise<WorkflowStepResult>;
  map<T, R>(
    ctx: C,
    name: string,
    items: T[],
    fn: (ctx: C, item: T) => Promise<R>,
    maxConcurrency: number
  ): Promise<R[]>;
  saveStep(state: WorkflowStepState): Promise<void>;
  isCancelled(): Promise<boolean>;
  newSessionId(): string;
}

export interface StepRuntime {
  status: WorkflowStepStatus;
  runs: number;
  sessionId: string;
  reviewerSessionId?: string;
  output?: string;
  feedback?: string;
  unapproved?: boolean;
  error?: string;
  startedAt?: string;
  /** Why the next run happens; consumed when the step is scheduled. */
  nextReason?: WorkerRunReason;
}

export type StepOutcome = (
  | { kind: 'done'; output: string; unapproved?: boolean; feedback?: string }
  | { kind: 'blocked'; output: string; feedback: string; targetStepId?: string }
  | { kind: 'failed'; error: string }
) & { startedAt?: string };

export interface WorkflowRunResult {
  status: 'completed' | 'failed' | 'cancelled';
  steps: Record<string, StepRuntime>;
  escalations: number;
}

function toState(workflowId: string, stepId: string, rt: StepRuntime, iteration = 0) {
  return {
    workflowId,
    stepId,
    status: rt.status,
    runs: rt.runs,
    iteration,
    sessionId: rt.sessionId,
    reviewerSessionId: rt.reviewerSessionId,
    output: rt.output,
    feedback: rt.feedback,
    unapproved: rt.unapproved,
    error: rt.error,
    startedAt: rt.startedAt,
    updatedAt: new Date().toISOString(),
  } satisfies WorkflowStepState;
}

/** Keeps the parent notification prompt bounded while showing every step. */
const INTERMEDIATE_OUTPUT_CHARS = 1500;
const FINAL_OUTPUT_CHARS_WHEN_LARGE = 5000;

export function descendantsOf(spec: WorkflowSpec, stepId: string): Set<string> {
  const result = new Set<string>();
  for (const step of spec.steps) {
    if (ancestorsOf(spec, step.id).has(stepId)) result.add(step.id);
  }
  return result;
}

export async function runWorkflow<C>(
  ctx: C,
  workflowId: string,
  spec: WorkflowSpec,
  ops: WorkflowOps<C>
): Promise<WorkflowRunResult> {
  const sessions = await ops.step(ctx, 'init-sessions', async () =>
    Object.fromEntries(
      spec.steps.map((s) => [
        s.id,
        { worker: ops.newSessionId(), reviewer: s.review ? ops.newSessionId() : undefined },
      ])
    )
  );
  const steps: Record<string, StepRuntime> = Object.fromEntries(
    spec.steps.map((s) => [
      s.id,
      {
        status: 'pending',
        runs: 0,
        sessionId: sessions[s.id].worker,
        reviewerSessionId: sessions[s.id].reviewer,
      } satisfies StepRuntime,
    ])
  );
  const maxConcurrency = spec.maxConcurrency ?? WORKFLOW_LIMITS.DEFAULT_CONCURRENCY;
  const maxWaves = spec.steps.length * (WORKFLOW_LIMITS.MAX_ESCALATIONS + 1) + 1;
  let escalations = 0;

  const outputs = () =>
    Object.fromEntries(Object.entries(steps).map(([id, rt]) => [id, rt.output]));

  for (let wave = 0; wave < maxWaves; wave++) {
    const ready = spec.steps.filter(
      (s) =>
        steps[s.id].status === 'pending' &&
        (s.dependsOn ?? []).every((d) => steps[d].status === 'done')
    );
    if (ready.length === 0) break;

    if (await ops.step(ctx, `cancel-check-${wave}`, () => ops.isCancelled())) {
      const open = spec.steps.filter((s) => steps[s.id].status === 'pending').map((s) => s.id);
      for (const id of open) steps[id].status = 'cancelled';
      await ops.step(ctx, 'save-cancelled', async () => {
        await Promise.all(open.map((id) => ops.saveStep(toState(workflowId, id, steps[id]))));
      });
      return { status: 'cancelled', steps, escalations };
    }

    const snapshot = outputs();
    const jobs = ready.map((step) => {
      const rt = steps[step.id];
      rt.runs += 1;
      const job = { step, run: rt.runs, reason: rt.nextReason ?? { kind: 'initial' as const } };
      rt.nextReason = undefined;
      return job;
    });

    const results = await ops.map(
      ctx,
      `wave-${wave}`,
      jobs,
      (c, job) => runStep(c, workflowId, spec, job, { ...steps[job.step.id] }, snapshot, ops),
      maxConcurrency
    );

    const changed = new Set<string>();
    const blocked: Array<{
      step: WorkflowStep;
      outcome: Extract<StepOutcome, { kind: 'blocked' }>;
    }> = [];
    jobs.forEach((job, i) => {
      const outcome = results[i];
      const rt = steps[job.step.id];
      changed.add(job.step.id);
      rt.startedAt = outcome.startedAt;
      if (outcome.kind === 'done') {
        Object.assign(rt, {
          status: 'done',
          output: outcome.output,
          unapproved: outcome.unapproved,
          feedback: outcome.feedback,
          error: undefined,
        });
      } else if (outcome.kind === 'failed') {
        Object.assign(rt, { status: 'failed', error: outcome.error });
      } else {
        blocked.push({ step: job.step, outcome });
      }
    });

    for (const { step, outcome } of blocked) {
      const rt = steps[step.id];
      const target = outcome.targetStepId;
      const valid = target !== undefined && ancestorsOf(spec, step.id).has(target);
      if (!valid || escalations >= WORKFLOW_LIMITS.MAX_ESCALATIONS) {
        Object.assign(rt, {
          status: 'failed',
          output: outcome.output,
          feedback: outcome.feedback,
          error: valid
            ? `Blocked after the escalation budget (${WORKFLOW_LIMITS.MAX_ESCALATIONS}) was used up`
            : `Blocked without a valid upstream targetStepId (got "${target ?? ''}")`,
        });
        continue;
      }
      // nextReason is cleared when a step is scheduled, so a 'downstream'
      // reason here was set earlier in this wave: merge into one re-run.
      const request = { fromStepId: step.id, feedback: outcome.feedback };
      const pending = steps[target].nextReason;
      if (pending?.kind === 'downstream') {
        pending.requests.push(request);
        steps[target].feedback = pending.requests.map((r) => r.feedback).join('\n\n');
      } else {
        escalations += 1;
        Object.assign(steps[target], {
          status: 'pending',
          feedback: outcome.feedback,
          nextReason: { kind: 'downstream', requests: [request] },
        });
      }
      changed.add(target);
      for (const id of descendantsOf(spec, target)) {
        const d = steps[id];
        if (id !== step.id && d.status !== 'done') continue;
        d.status = 'pending';
        // A step that is itself an escalation target keeps that reason; its
        // prompt carries the updated upstream outputs anyway.
        if (d.nextReason?.kind === 'upstreamChanged') {
          if (!d.nextReason.changedStepIds.includes(target))
            d.nextReason.changedStepIds.push(target);
        } else if (d.nextReason?.kind !== 'downstream') {
          d.nextReason = { kind: 'upstreamChanged', changedStepIds: [target] };
        }
        changed.add(id);
      }
    }

    await ops.step(ctx, `save-wave-${wave}`, async () => {
      await Promise.all([...changed].map((id) => ops.saveStep(toState(workflowId, id, steps[id]))));
    });
  }

  // Steps that can never run because an ancestor failed.
  const skipped: string[] = [];
  for (const s of spec.steps) {
    if (steps[s.id].status === 'pending') {
      steps[s.id].status = 'skipped';
      skipped.push(s.id);
    }
  }
  if (skipped.length > 0) {
    await ops.step(ctx, 'save-skipped', async () => {
      await Promise.all(skipped.map((id) => ops.saveStep(toState(workflowId, id, steps[id]))));
    });
  }

  const allDone = spec.steps.every((s) => steps[s.id].status === 'done');
  return { status: allDone ? 'completed' : 'failed', steps, escalations };
}

type RunResult = { ok: true; result: WorkflowStepResult } | { ok: false; error: string };

/** A worker turn that ends the step early: it failed, or it needs an upstream redo. */
function workerOutcome(result: WorkflowStepResult): StepOutcome | undefined {
  if (result.status === 'failed') {
    const reason = result.feedback ?? result.output;
    return { kind: 'failed', error: `Step reported failure: ${reason.slice(0, 2000)}` };
  }
  if (result.status === 'blocked') {
    return {
      kind: 'blocked',
      output: result.output,
      feedback: result.feedback ?? result.output,
      targetStepId: result.targetStepId,
    };
  }
  return undefined;
}

async function runStep<C>(
  ctx: C,
  workflowId: string,
  spec: WorkflowSpec,
  job: { step: WorkflowStep; run: number; reason: WorkerRunReason },
  rt: StepRuntime,
  outputs: Record<string, string | undefined>,
  ops: WorkflowOps<C>
): Promise<StepOutcome> {
  // Stamped inside the durable step so replay reuses the original time.
  rt.startedAt = await ops.step(ctx, `${job.step.id}-r${job.run}-start`, async () => {
    const startedAt = new Date().toISOString();
    await ops.saveStep(
      toState(workflowId, job.step.id, { ...rt, startedAt, status: 'running', error: undefined })
    );
    return startedAt;
  });
  const outcome = await runStepTurns(ctx, workflowId, spec, job, rt, outputs, ops);
  return { ...outcome, startedAt: rt.startedAt };
}

async function runStepTurns<C>(
  ctx: C,
  workflowId: string,
  spec: WorkflowSpec,
  job: { step: WorkflowStep; run: number; reason: WorkerRunReason },
  rt: StepRuntime,
  outputs: Record<string, string | undefined>,
  ops: WorkflowOps<C>
): Promise<StepOutcome> {
  const { step, run } = job;
  const base = `${step.id}-r${run}`;
  const save = (name: string, status: WorkflowStepStatus, iteration: number, extra = {}) =>
    ops.step(ctx, `${base}-${name}`, () =>
      ops.saveStep(toState(workflowId, step.id, { ...rt, ...extra, status }, iteration))
    );

  const call = async (name: string, turn: AgentTurn): Promise<RunResult> => {
    try {
      return { ok: true, result: await ops.runAgent(ctx, `${base}-${name}`, turn) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const work = (reason: WorkerRunReason, round: number) =>
    call(`work${round}`, {
      stepId: step.id,
      role: 'worker',
      agentId: step.agentId,
      sessionId: rt.sessionId,
      modelId: step.modelId,
      prompt: buildWorkerPrompt(spec, step, outputs, reason),
    });

  let res = await work(job.reason, 0);
  if (!res.ok) return { kind: 'failed', error: res.error };
  const early = workerOutcome(res.result);
  if (early) return early;
  if (!step.review) return { kind: 'done', output: res.result.output };

  const maxIterations = step.review.maxIterations ?? WORKFLOW_LIMITS.DEFAULT_REVIEW_ITERATIONS;
  for (let round = 1; ; round++) {
    await save(`reviewing${round}`, 'reviewing', round, { output: res.result.output });
    const review = await call(`review${round}`, {
      stepId: step.id,
      role: 'reviewer',
      agentId: step.review.agentId,
      sessionId: rt.reviewerSessionId!,
      modelId: step.review.modelId,
      prompt: buildReviewerPrompt(spec, step, outputs, res.result.output, round),
    });
    if (!review.ok) return { kind: 'failed', error: `Reviewer failed: ${review.error}` };
    if (review.result.status === 'failed') {
      const reason = review.result.feedback ?? review.result.output;
      return { kind: 'failed', error: `Reviewer reported failure: ${reason.slice(0, 2000)}` };
    }
    if (review.result.status === 'done') {
      return { kind: 'done', output: res.result.output, feedback: review.result.output };
    }
    const feedback = review.result.feedback ?? review.result.output;
    if (round >= maxIterations) {
      return { kind: 'done', output: res.result.output, unapproved: true, feedback };
    }
    await save(`revising${round}`, 'running', round, { feedback });
    res = await work({ kind: 'review', feedback, round }, round);
    if (!res.ok) return { kind: 'failed', error: res.error };
    const early = workerOutcome(res.result);
    if (early) return early;
  }
}

/** Human/agent-readable summary used for the workflow result and the parent notification. */
export function summarize(spec: WorkflowSpec, result: WorkflowRunResult): string {
  const hasDependants = new Set(spec.steps.flatMap((s) => s.dependsOn ?? []));
  const lines = spec.steps.map((s) => {
    const rt = result.steps[s.id];
    const notes = [
      rt.unapproved ? 'review not approved within maxIterations' : '',
      rt.error ? `error: ${rt.error}` : '',
      rt.runs > 1 ? `runs: ${rt.runs}` : '',
    ].filter(Boolean);
    return `- ${s.id} (${s.agentId}): ${rt.status}${notes.length ? ` — ${notes.join('; ')}` : ''}`;
  });
  const build = (finalMax?: number) => {
    const text = `Status: ${result.status}\n\nSteps:\n${lines.join('\n')}${section(
      'Final outputs',
      spec.steps.filter((s) => !hasDependants.has(s.id)),
      finalMax
    )}${section(
      `Intermediate outputs (truncated to ${INTERMEDIATE_OUTPUT_CHARS} chars; use run_workflow status for full text)`,
      spec.steps.filter((s) => hasDependants.has(s.id)),
      INTERMEDIATE_OUTPUT_CHARS
    )}`;
    return text;
  };
  const section = (title: string, ids: WorkflowStep[], max?: number) => {
    const parts = ids
      .filter((s) => result.steps[s.id].output)
      .map((s) => {
        const out = result.steps[s.id].output!;
        return `### ${s.id}\n${max && out.length > max ? `${out.slice(0, max)}…` : out}`;
      });
    return parts.length ? `\n\n${title}:\n${parts.join('\n\n')}` : '';
  };
  // The summary is stored in the header item (400 KB with the spec) and sent
  // to the parent agent, so final outputs are cut when they would not fit.
  const max = WORKFLOW_LIMITS.MAX_SUMMARY_LENGTH;
  let text = build();
  if (text.length > max) text = build(FINAL_OUTPUT_CHARS_WHEN_LARGE);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
