/**
 * Workflows API — start, inspect and cancel multi-agent workflows.
 *
 * The Backend owns the user binding: `userId` comes from the verified JWT (or
 * `X-Target-User-Id` for machine users), and the orchestrator only ever acts
 * for the userId stored here. This keeps developer-auth token minting out of
 * the Runtime's reach.
 */

import { Router } from 'express';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { isAgentId, isSessionId, parseAgentId } from '@moca/core';
import {
  isTerminalWorkflowStatus,
  validateWorkflowSpec,
  workflowSpecSchema,
  type WorkflowOrchestratorEvent,
  type WorkflowRecord,
  type WorkflowStepState,
} from '@moca/tool-definitions';
import { type AuthenticatedRequest, resolveTargetUser } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { config } from '../config/index.js';
import { AppError, ErrorCode, ok, parseLimit } from '../libs/http/index.js';
import { logger } from '../libs/logger/index.js';
import { createAgentsService } from '../services/agents-service.js';
import { getWorkflowsRepository } from '../repositories/workflows/workflows-repository.factory.js';

const router = Router();

/** Bounds Runtime sessions and model spend a single user can fan out at once. */
export const MAX_ACTIVE_WORKFLOWS_PER_USER = 3;
const ACTIVE_SCAN_LIMIT = 50;
/**
 * Matches the orchestrator's durable executionTimeout. A record still
 * non-terminal after that never finished (timeout, crash before the catch
 * block) and must not hold a slot until its 30-day TTL.
 */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function activeWorkflows(records: WorkflowRecord[], now = Date.now()): WorkflowRecord[] {
  return records.filter(
    (w) => !isTerminalWorkflowStatus(w.status) && now - Date.parse(w.createdAt) < ACTIVE_WINDOW_MS
  );
}

const workflowIdParams = z.object({ id: z.string().regex(/^wf-[0-9a-f-]{36}$/) });

const createWorkflowBody = z.object({
  workflow: workflowSpecSchema,
  parent: z
    .object({
      sessionId: z.string().max(100).optional(),
      sessionType: z.enum(['user', 'event', 'subagent']).optional(),
      agentId: z.string().optional(),
      modelId: z.string().max(200).optional(),
      storagePath: z.string().max(1024).optional(),
    })
    .optional(),
});

let lambdaClient: LambdaClient | undefined;

function getRepository() {
  const repo = getWorkflowsRepository();
  if (!repo.isConfigured() || !config.WORKFLOW_ORCHESTRATOR_ARN) {
    throw new AppError(ErrorCode.CONFIGURATION_ERROR, 'Workflows are not configured');
  }
  return repo;
}

async function invokeOrchestrator(event: WorkflowOrchestratorEvent, executionName: string) {
  lambdaClient ??= new LambdaClient({ region: config.AWS_REGION });
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: config.WORKFLOW_ORCHESTRATOR_ARN,
      InvocationType: 'Event',
      // Same name + payload → Lambda returns the existing execution, so a
      // retried request never starts the workflow twice.
      DurableExecutionName: executionName,
      Payload: new TextEncoder().encode(JSON.stringify(event)),
    })
  );
}

function serialize(record: WorkflowRecord, steps?: WorkflowStepState[]) {
  const rest = { ...record, userId: undefined };
  if (!steps) {
    const { spec, ...summary } = rest;
    return { ...summary, goal: spec.goal, stepCount: spec.steps.length };
  }
  const order = new Map(record.spec.steps.map((s, i) => [s.id, i]));
  return {
    ...rest,
    steps: [...steps].sort((a, b) => (order.get(a.stepId) ?? 0) - (order.get(b.stepId) ?? 0)),
  };
}

/** POST /workflows — validate, persist, and start the durable execution. */
router.post(
  '/',
  resolveTargetUser,
  validate({ body: createWorkflowBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.targetUserId!;
    const { workflow, parent } = req.body as z.infer<typeof createWorkflowBody>;
    const repo = getRepository();

    const problems = validateWorkflowSpec(workflow);
    const agentIds = new Set(
      workflow.steps.flatMap((s) => [s.agentId, ...(s.review ? [s.review.agentId] : [])])
    );
    for (const agentId of agentIds) {
      if (!isAgentId(agentId)) problems.push(`"${agentId}" is not a valid agentId`);
    }
    if (problems.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, problems.join('; '));
    }

    const agentsService = createAgentsService();
    const missing: string[] = [];
    for (const agentId of agentIds) {
      if (!(await agentsService.getAgent(userId, parseAgentId(agentId)))) missing.push(agentId);
    }
    if (missing.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Unknown agentId(s): ${missing.join(', ')}`);
    }

    const tooMany = (active: number) =>
      new AppError(
        ErrorCode.CONFLICT,
        `Too many running workflows (${active}/${MAX_ACTIVE_WORKFLOWS_PER_USER}). Wait for one to finish or cancel it.`
      );
    const before = activeWorkflows(await repo.list(userId, ACTIVE_SCAN_LIMIT));
    if (before.length >= MAX_ACTIVE_WORKFLOWS_PER_USER) throw tooMany(before.length);

    const now = new Date().toISOString();
    const workflowId = `wf-${uuidv7()}`;
    const record: WorkflowRecord = {
      workflowId,
      userId,
      status: 'pending',
      spec: workflow,
      parent: parent && {
        ...parent,
        sessionId: parent.sessionId && isSessionId(parent.sessionId) ? parent.sessionId : undefined,
        agentId: parent.agentId && isAgentId(parent.agentId) ? parent.agentId : undefined,
      },
      createdAt: now,
      updatedAt: now,
    };
    const steps: WorkflowStepState[] = workflow.steps.map((s) => ({
      workflowId,
      stepId: s.id,
      status: 'pending',
      runs: 0,
      iteration: 0,
      updatedAt: now,
    }));
    await repo.create(record, steps);

    // Re-check after the write: concurrent starts all pass the first check.
    // Ids are UUIDv7 (time-ordered), so the earliest MAX keep their slot and
    // only the late ones are rejected.
    const after = activeWorkflows(
      await repo.list(userId, ACTIVE_SCAN_LIMIT, { consistentRead: true })
    ).map((w) => w.workflowId);
    after.sort();
    if (after.indexOf(workflowId) >= MAX_ACTIVE_WORKFLOWS_PER_USER) {
      await repo.markFailed(userId, workflowId, 'Too many running workflows');
      throw tooMany(after.length - 1);
    }

    try {
      await invokeOrchestrator({ action: 'run', workflowId, userId }, workflowId);
    } catch (error) {
      logger.error({ err: error, workflowId }, 'Failed to start workflow orchestrator');
      await repo.markFailed(userId, workflowId, 'Failed to start the orchestrator');
      throw new AppError(ErrorCode.UPSTREAM_ERROR, 'Failed to start the workflow', {
        cause: error,
      });
    }

    logger.info({ workflowId, steps: workflow.steps.length }, 'Workflow started');
    res.status(202).json(ok(req, { workflowId, status: 'pending' }, { userId }));
  })
);

/** GET /workflows — newest first. */
router.get(
  '/',
  resolveTargetUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.targetUserId!;
    const workflows = await getRepository().list(userId, parseLimit(req, 20));
    res.status(200).json(ok(req, { workflows: workflows.map((w) => serialize(w)) }, { userId }));
  })
);

/** GET /workflows/:id — header plus per-step state. */
router.get(
  '/:id',
  resolveTargetUser,
  validate({ params: workflowIdParams }),
  asyncHandler(async (req: AuthenticatedRequest<{ id: string }>, res) => {
    const userId = req.targetUserId!;
    const repo = getRepository();
    const record = await repo.get(userId, req.params.id);
    if (!record) throw new AppError(ErrorCode.NOT_FOUND, 'Workflow not found');
    const steps = await repo.listSteps(userId, req.params.id);
    res.status(200).json(ok(req, { workflow: serialize(record, steps) }, { userId }));
  })
);

/**
 * POST /workflows/:id/cancel — flag the record (the orchestrator stops at its
 * next checkpoint) and start a cancel execution that stops the running
 * execution and its step sessions immediately.
 */
router.post(
  '/:id/cancel',
  resolveTargetUser,
  validate({ params: workflowIdParams }),
  asyncHandler(async (req: AuthenticatedRequest<{ id: string }>, res) => {
    const userId = req.targetUserId!;
    const workflowId = req.params.id;
    const repo = getRepository();
    const record = await repo.get(userId, workflowId);
    if (!record) throw new AppError(ErrorCode.NOT_FOUND, 'Workflow not found');
    if (isTerminalWorkflowStatus(record.status)) {
      res.status(200).json(ok(req, { workflowId, status: record.status }, { userId }));
      return;
    }
    await repo.requestCancel(userId, workflowId);
    await invokeOrchestrator({ action: 'cancel', workflowId, userId }, `${workflowId}-cancel`);
    res.status(202).json(ok(req, { workflowId, status: 'cancelling' }, { userId }));
  })
);

export default router;
