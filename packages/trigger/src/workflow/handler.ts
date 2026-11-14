/**
 * Workflow orchestrator — a Lambda durable function, one execution per
 * workflow (execution name = workflowId).
 *
 * Each step turn is started on the AgentCore Runtime in its own session and
 * the execution suspends on a durable callback until the Runtime reports the
 * result, so waiting costs no compute and is not bounded by Lambda's 15 min
 * invocation limit.
 */

import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js';
import {
  LambdaClient,
  ListDurableExecutionsByFunctionCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import { generateSessionId } from '@moca/core';
import {
  isTerminalWorkflowStatus,
  WORKFLOW_NOTIFICATION_PREFIX,
  type WorkflowOrchestratorEvent,
  type WorkflowRecord,
  type WorkflowStepResult,
} from '@moca/tool-definitions';
import { AuthService } from '../services/auth-service.js';
import { createAgentsService } from '../services/agents-service.js';
import { createLogger } from '../libs/logger/index.js';
import { runWorkflow, summarize, type WorkflowOps } from './engine.js';
import { AgentNotFoundError, RuntimeClient } from './runtime-client.js';
import { WorkflowStore } from './store.js';

const log = createLogger('WorkflowOrchestrator');

/** A single step turn may use the whole microVM lifetime. */
const STEP_TIMEOUT = { hours: 8 } as const;
/** The Runtime heartbeats every 5 min; three missed beats mean the microVM is gone. */
const STEP_HEARTBEAT_TIMEOUT = { minutes: 20 } as const;
/** A failed turn (model error, dead microVM) is retried once on the same session. */
const STEP_TURN_ATTEMPTS = 2;
const STEP_RETRY_DELAY = { seconds: 30 } as const;
const NOTIFY_ATTEMPTS = 30;
const NOTIFY_RETRY_DELAY = { seconds: 60 } as const;

/** The submitter's error may arrive wrapped by the SDK, so match the message too. */
function isAgentNotFound(error: unknown): boolean {
  return (
    error instanceof AgentNotFoundError ||
    (error instanceof Error && error.message.includes('Agent not found'))
  );
}

let deps: { store: WorkflowStore; runtime: RuntimeClient } | undefined;
function getDeps() {
  if (!deps) {
    const agentApiUrl = process.env.AGENT_API_URL;
    if (!agentApiUrl) throw new Error('AGENT_API_URL environment variable is required');
    deps = {
      store: WorkflowStore.fromEnvironment(),
      runtime: new RuntimeClient(AuthService.fromEnvironment(), createAgentsService(), agentApiUrl),
    };
  }
  return deps;
}

export function buildOps(
  record: WorkflowRecord,
  { store, runtime }: { store: WorkflowStore; runtime: RuntimeClient } = getDeps()
): WorkflowOps<DurableContext> {
  const { userId, workflowId } = record;
  return {
    step: (c, name, fn) => c.step(name, () => fn()),
    runAgent: async (c, name, turn) => {
      const submit = async (callbackId: string) => {
        await runtime.startTurn({
          userId,
          sessionId: turn.sessionId,
          sessionType: 'subagent',
          agentId: turn.agentId,
          modelId: turn.modelId,
          prompt: turn.prompt,
          storagePath: record.parent?.storagePath,
          workflowStep: {
            workflowId,
            stepId: turn.stepId,
            role: turn.role,
            callbackId,
            parentSessionId: record.parent?.sessionId,
            goal: record.spec.goal,
          },
        });
      };
      // waitForCallback's retryStrategy only covers the submitter (starting
      // the turn). A turn that fails or stops heartbeating rejects the
      // callback without retry, so the whole turn is retried here.
      for (let attempt = 1; ; attempt++) {
        try {
          const raw = await c.waitForCallback<string>(
            attempt === 1 ? name : `${name}-retry${attempt - 1}`,
            submit,
            {
              timeout: STEP_TIMEOUT,
              heartbeatTimeout: STEP_HEARTBEAT_TIMEOUT,
              retryStrategy: (error, submitAttempt) => ({
                shouldRetry: submitAttempt < 3 && !isAgentNotFound(error),
                delay: { seconds: 10 },
              }),
            }
          );
          return JSON.parse(raw) as WorkflowStepResult;
        } catch (error) {
          if (attempt >= STEP_TURN_ATTEMPTS || isAgentNotFound(error)) throw error;
          log.warn({ err: error, workflowId, stepId: turn.stepId, attempt }, 'Retrying step turn');
          await c.wait(`${name}-backoff${attempt}`, STEP_RETRY_DELAY);
        }
      }
    },
    map: async (c, name, items, fn, maxConcurrency) => {
      const batch = await c.map(name, items, (child, item) => fn(child, item), {
        maxConcurrency,
        // Wait for every step: one failure must not abandon running siblings.
        completionConfig: { toleratedFailurePercentage: 100 },
      });
      const ordered = [...batch.all].sort((a, b) => a.index - b.index);
      return ordered.map(
        (item) =>
          item.result ??
          ({ kind: 'failed', error: item.error?.message ?? 'Step did not complete' } as never)
      );
    },
    saveStep: (state) => store.saveStep(userId, state),
    isCancelled: async () => {
      const current = await store.get(userId, workflowId);
      return !current || current.status === 'cancelled' || current.cancelRequested === true;
    },
    newSessionId: () => generateSessionId(),
  };
}

function notificationPrompt(record: WorkflowRecord, summary: string): string {
  return `${WORKFLOW_NOTIFICATION_PREFIX} The background workflow ${record.workflowId} you started has finished.

Goal: ${record.spec.goal}

${summary}

Report the outcome to the user: summarize the results, point out failed or unapproved steps, and suggest next steps if useful. Do not start the same workflow again unless the user asks.`;
}

async function notifyParent(ctx: DurableContext, record: WorkflowRecord, summary: string) {
  const parent = record.parent;
  if (record.spec.notifyOnComplete === false || !parent?.sessionId || !parent.agentId) return;
  const { runtime } = getDeps();
  for (let attempt = 0; attempt < NOTIFY_ATTEMPTS; attempt++) {
    const outcome = await ctx.step(`notify-${attempt}`, async () => {
      try {
        return await runtime.startTurn({
          userId: record.userId,
          sessionId: parent.sessionId!,
          sessionType: parent.sessionType ?? 'user',
          agentId: parent.agentId!,
          modelId: parent.modelId,
          storagePath: parent.storagePath,
          prompt: notificationPrompt(record, summary),
        });
      } catch (error) {
        log.warn({ err: error, workflowId: record.workflowId }, 'Parent notification failed');
        return { inProgress: false, failed: true };
      }
    });
    if (!outcome.inProgress) return;
    // The user is mid-turn in that session; try again once it is free.
    await ctx.wait(`notify-wait-${attempt}`, NOTIFY_RETRY_DELAY);
  }
}

async function cancelWorkflow(userId: string, workflowId: string): Promise<void> {
  const { store } = getDeps();
  const record = await store.get(userId, workflowId);
  if (!record || isTerminalWorkflowStatus(record.status)) return;

  const lambda = new LambdaClient({ region: process.env.AWS_REGION });
  const executions = await lambda.send(
    new ListDurableExecutionsByFunctionCommand({
      // Lambda rejects a name filter combined with Qualifier or Statuses.
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      DurableExecutionName: workflowId,
    })
  );
  for (const execution of executions.DurableExecutions ?? []) {
    // The name filter is not documented as exact; never stop `<id>-cancel` (ourselves).
    if (
      !execution.DurableExecutionArn ||
      execution.Status !== 'RUNNING' ||
      execution.DurableExecutionName !== workflowId
    ) {
      continue;
    }
    await lambda.send(
      new StopDurableExecutionCommand({
        DurableExecutionArn: execution.DurableExecutionArn,
        Error: { ErrorType: 'Cancelled', ErrorMessage: 'Workflow cancelled by user' },
      })
    );
  }

  const { runtime } = getDeps();
  const now = new Date().toISOString();
  for (const step of await store.listSteps(userId, workflowId)) {
    if (step.status !== 'running' && step.status !== 'reviewing' && step.status !== 'pending') {
      continue;
    }
    if (step.status !== 'pending') {
      for (const sessionId of [step.sessionId, step.reviewerSessionId]) {
        if (!sessionId) continue;
        await runtime
          .stopSession(sessionId)
          .catch((err: unknown) => log.warn({ err, sessionId }, 'StopRuntimeSession failed'));
      }
    }
    await store.saveStep(userId, { ...step, status: 'cancelled', updatedAt: now });
  }
  await store.setStatus(userId, workflowId, 'cancelled');
}

async function orchestrate(event: WorkflowOrchestratorEvent, ctx: DurableContext) {
  const { store } = getDeps();
  const { userId, workflowId } = event;

  if (event.action === 'cancel') {
    await ctx.step('cancel', () => cancelWorkflow(userId, workflowId));
    return { workflowId, status: 'cancelled' };
  }

  const record = await ctx.step('load', () => store.get(userId, workflowId));
  if (!record || isTerminalWorkflowStatus(record.status)) {
    return { workflowId, status: record?.status ?? 'not_found' };
  }
  await ctx.step('mark-running', () => store.setStatus(userId, workflowId, 'running'));

  try {
    const result = await runWorkflow(ctx, workflowId, record.spec, buildOps(record));
    const summary = summarize(record.spec, result);
    await ctx.step('finalize', () =>
      store.setStatus(userId, workflowId, result.status, { result: summary })
    );
    if (result.status !== 'cancelled') await notifyParent(ctx, record, summary);
    return { workflowId, status: result.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.step('mark-failed', () =>
      store.setStatus(userId, workflowId, 'failed', { error: message })
    );
    throw error;
  }
}

export const handler = withDurableExecution(orchestrate);
