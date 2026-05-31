/**
 * Triggers API endpoints
 * API for managing event-driven agent triggers.
 *
 * Handlers are wrapped in `asyncHandler` and signal failures by throwing
 * `AppError`; the global `errorHandlerMiddleware` renders the canonical error
 * envelope. Request shapes are validated by `validate(...)` middleware, so
 * handlers receive already-typed `params`/`body`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { parseTriggerId } from '@moca/core';
import { type AuthenticatedRequest, getCurrentAuth, requireUserId } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import {
  getTriggersDynamoDBService,
  MAX_TRIGGERS_PER_USER,
  TriggerLimitExceededError,
  type TriggerType,
} from '../services/triggers-dynamodb.js';
import {
  getSchedulerService,
  InvalidScheduleIntervalError,
} from '../services/scheduler-service.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import {
  AppError,
  ErrorCode,
  decodePageToken,
  encodePageToken,
  ok,
  parseLimit,
  queryString,
  zTriggerId,
} from '../libs/http/index.js';

const router = Router();

/** `:id` path param schema shared by every item route. */
const triggerIdParams = z.object({ id: zTriggerId });

/**
 * Project a stored Trigger into the public API shape (omits DynamoDB
 * internals like PK/SK/GSI keys). Shared by every endpoint that returns a
 * trigger so the response shape cannot drift between routes.
 */
function serializeTrigger(trigger: {
  id: string;
  name: string;
  description?: string;
  type: string;
  enabled: boolean;
  agentId: string;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: unknown;
  eventConfig?: unknown;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
}) {
  return {
    id: trigger.id,
    name: trigger.name,
    description: trigger.description,
    type: trigger.type,
    enabled: trigger.enabled,
    agentId: trigger.agentId,
    prompt: trigger.prompt,
    sessionId: trigger.sessionId,
    modelId: trigger.modelId,
    workingDirectory: trigger.workingDirectory,
    enabledTools: trigger.enabledTools,
    scheduleConfig: trigger.scheduleConfig,
    eventConfig: trigger.eventConfig,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
    lastExecutedAt: trigger.lastExecutedAt,
  };
}

/**
 * Return the configured triggers service, throwing CONFIGURATION_ERROR when
 * the table is not wired up (kept as a guard so handlers stay flat).
 */
function getConfiguredTriggersService() {
  const service = getTriggersDynamoDBService();
  if (!service.isConfigured()) {
    throw new AppError(ErrorCode.CONFIGURATION_ERROR, 'Triggers Table is not configured');
  }
  return service;
}

/**
 * Map an InvalidScheduleIntervalError to a VALIDATION_ERROR AppError,
 * preserving the domain-specific code in details. Returns the wrapped error so
 * callers can `throw mapScheduleError(e)`.
 */
function mapScheduleError(error: unknown): AppError {
  if (error instanceof InvalidScheduleIntervalError) {
    return new AppError(ErrorCode.VALIDATION_ERROR, error.message, {
      details: { scheduleErrorCode: error.code },
    });
  }
  return new AppError(
    ErrorCode.INTERNAL_ERROR,
    `Failed to create schedule: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  );
}

/**
 * List all triggers for the authenticated user (paginated, optional ?type).
 * GET /triggers
 */
router.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);

    // Default page size = the per-user hard limit, so a user's entire trigger
    // set fits in a single page (clamped by parseLimit's MAX_PAGE_SIZE).
    const limit = parseLimit(req, MAX_TRIGGERS_PER_USER);
    const type = queryString(req.query.type);
    if (type && type !== 'schedule' && type !== 'event') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid type filter: "${type}"`);
    }
    const exclusiveStartKey = decodePageToken(queryString(req.query.nextToken));

    logger.info(
      { userId, username: auth.username, limit, type, hasNextToken: !!req.query.nextToken },
      'Triggers list retrieval started (%s):',
      auth.requestId
    );

    const result = await getConfiguredTriggersService().listTriggers(userId, {
      limit,
      type: type as TriggerType | undefined,
      exclusiveStartKey,
    });

    const nextToken = encodePageToken(result.lastEvaluatedKey);

    logger.info(
      `Triggers list retrieval completed (${auth.requestId}): ${result.triggers.length} items, hasMore: ${!!nextToken}`
    );

    res.status(200).json(
      ok(
        req,
        { triggers: result.triggers.map(serializeTrigger), nextToken },
        { userId, count: result.triggers.length }
      )
    );
  })
);

/**
 * Get a specific trigger
 * GET /triggers/:id
 */
router.get(
  '/:id',
  validate({ params: triggerIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const triggerId = parseTriggerId(req.params.id);

    const trigger = await getConfiguredTriggersService().getTrigger(userId, triggerId);
    if (!trigger) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Trigger not found');
    }

    res.status(200).json(ok(req, { trigger: serializeTrigger(trigger) }, { userId }));
  })
);

/** Request body for creating a trigger. */
const createTriggerBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['schedule', 'event']),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  modelId: z.string().optional(),
  workingDirectory: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  scheduleConfig: z.record(z.string(), z.unknown()).optional(),
  eventConfig: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Create a new trigger
 * POST /triggers
 */
router.post(
  '/',
  validate({ body: createTriggerBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);
    const {
      name,
      description,
      type,
      agentId,
      prompt,
      sessionId,
      modelId,
      workingDirectory,
      enabledTools,
      scheduleConfig,
      eventConfig,
    } = req.body;

    if (type === 'schedule' && !scheduleConfig?.expression) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'scheduleConfig.expression is required for schedule type triggers'
      );
    }

    logger.info({ userId, name, type, agentId }, 'Trigger creation started (%s):', auth.requestId);

    const triggersService = getConfiguredTriggersService();
    let trigger;
    try {
      trigger = await triggersService.createTrigger({
        userId,
        name,
        description,
        type,
        agentId,
        prompt,
        sessionId,
        modelId,
        workingDirectory,
        enabledTools,
        scheduleConfig,
        eventConfig,
      });
    } catch (e) {
      if (e instanceof TriggerLimitExceededError) {
        throw new AppError(ErrorCode.CONFLICT, e.message, { details: { limit: e.limit } });
      }
      throw e;
    }

    // If schedule type, create the backing EventBridge Schedule.
    if (type === 'schedule' && scheduleConfig) {
      try {
        const schedulerService = getSchedulerService();
        const targetArn = config.TRIGGER_LAMBDA_ARN;
        const roleArn = config.SCHEDULER_ROLE_ARN;
        if (!targetArn || !roleArn) {
          throw new Error('TRIGGER_LAMBDA_ARN or SCHEDULER_ROLE_ARN not configured');
        }

        const schedulerArn = await schedulerService.createSchedule({
          name: `trigger-${trigger.id}`,
          expression: scheduleConfig.expression,
          timezone: scheduleConfig.timezone,
          payload: {
            triggerId: trigger.id,
            userId,
            agentId,
            prompt,
            sessionId,
            modelId,
            workingDirectory,
            enabledTools,
          },
          targetArn,
          roleArn,
        });

        await triggersService.updateTrigger(userId, trigger.id, {
          scheduleConfig: { ...scheduleConfig, schedulerArn, scheduleGroupName: 'default' },
        });

        logger.info(`EventBridge Schedule created: ${schedulerArn}`);
      } catch (scheduleError) {
        logger.error({ err: scheduleError }, 'Failed to create EventBridge Schedule:');
        // Rollback: delete the trigger so the DynamoDB row does not linger
        // without a backing EventBridge Schedule.
        await triggersService.deleteTrigger(userId, trigger.id);
        throw mapScheduleError(scheduleError);
      }
    }

    logger.info('Trigger created successfully (%s): %s', auth.requestId, trigger.id);

    res.status(201).json(ok(req, { trigger: serializeTrigger(trigger) }, { userId }));
  })
);

/** Request body for updating a trigger (partial). */
const updateTriggerBody = createTriggerBody.partial();

/**
 * Update a trigger
 * PUT /triggers/:id
 */
router.put(
  '/:id',
  validate({ params: triggerIdParams, body: updateTriggerBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);
    const triggerId = parseTriggerId(req.params.id);

    const triggersService = getConfiguredTriggersService();
    const existingTrigger = await triggersService.getTrigger(userId, triggerId);
    if (!existingTrigger) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Trigger not found');
    }

    const {
      name,
      description,
      type,
      agentId,
      prompt,
      sessionId,
      modelId,
      workingDirectory,
      enabledTools,
      scheduleConfig,
      eventConfig,
    } = req.body;

    const typeChanged = type && type !== existingTrigger.type;

    // Type change: schedule -> event — tear down the EventBridge Schedule.
    if (typeChanged && existingTrigger.type === 'schedule' && type === 'event') {
      logger.info('Type change detected: schedule -> event (%s)', auth.requestId);
      try {
        await getSchedulerService().deleteSchedule(triggerId);
        logger.info('EventBridge Schedule deleted for type change');
      } catch (scheduleError) {
        logger.warn(
          { err: scheduleError },
          'Failed to delete EventBridge Schedule during type change:'
        );
      }
    }

    // Type change: event -> schedule — create a new EventBridge Schedule.
    if (typeChanged && existingTrigger.type === 'event' && type === 'schedule') {
      logger.info('Type change detected: event -> schedule (%s)', auth.requestId);
      if (!scheduleConfig?.expression) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          'scheduleConfig.expression is required when changing to schedule type'
        );
      }
      try {
        const schedulerService = getSchedulerService();
        const targetArn = config.TRIGGER_LAMBDA_ARN;
        const roleArn = config.SCHEDULER_ROLE_ARN;
        if (!targetArn || !roleArn) {
          throw new Error('TRIGGER_LAMBDA_ARN or SCHEDULER_ROLE_ARN not configured');
        }
        const schedulerArn = await schedulerService.createSchedule({
          name: `trigger-${triggerId}`,
          expression: scheduleConfig.expression,
          timezone: scheduleConfig.timezone,
          payload: {
            triggerId,
            userId,
            agentId: agentId || existingTrigger.agentId,
            prompt: prompt || existingTrigger.prompt,
            sessionId: sessionId !== undefined ? sessionId : existingTrigger.sessionId,
            modelId: modelId !== undefined ? modelId : existingTrigger.modelId,
            workingDirectory:
              workingDirectory !== undefined ? workingDirectory : existingTrigger.workingDirectory,
            enabledTools: enabledTools || existingTrigger.enabledTools,
          },
          targetArn,
          roleArn,
        });
        logger.info(`EventBridge Schedule created for type change: ${schedulerArn}`);
      } catch (scheduleError) {
        logger.error(
          { err: scheduleError },
          'Failed to create EventBridge Schedule during type change:'
        );
        throw mapScheduleError(scheduleError);
      }
    }

    const updatedTrigger = await triggersService.updateTrigger(userId, triggerId, {
      name,
      description,
      type,
      agentId,
      prompt,
      sessionId,
      modelId,
      workingDirectory,
      enabledTools,
      scheduleConfig,
      eventConfig,
    });

    // Same-type schedule update: push config changes to EventBridge.
    if (updatedTrigger.type === 'schedule' && !typeChanged && scheduleConfig) {
      try {
        const schedulerService = getSchedulerService();
        const targetArn = config.TRIGGER_LAMBDA_ARN;
        const roleArn = config.SCHEDULER_ROLE_ARN;
        if (targetArn && roleArn) {
          await schedulerService.updateSchedule(triggerId, {
            expression: scheduleConfig.expression,
            timezone: scheduleConfig.timezone,
            payload: {
              triggerId,
              userId,
              agentId: agentId || existingTrigger.agentId,
              prompt: prompt || existingTrigger.prompt,
              sessionId: sessionId !== undefined ? sessionId : existingTrigger.sessionId,
              modelId: modelId !== undefined ? modelId : existingTrigger.modelId,
              workingDirectory:
                workingDirectory !== undefined
                  ? workingDirectory
                  : existingTrigger.workingDirectory,
              enabledTools: enabledTools || existingTrigger.enabledTools,
            },
            targetArn,
            roleArn,
          });
        }
      } catch (scheduleError) {
        // An invalid interval on update is a client error — surface it.
        if (scheduleError instanceof InvalidScheduleIntervalError) {
          throw mapScheduleError(scheduleError);
        }
        logger.warn({ err: scheduleError }, 'Failed to update EventBridge Schedule (non-critical):');
      }
    }

    logger.info('Trigger updated successfully (%s)', auth.requestId);

    res.status(200).json(ok(req, { trigger: serializeTrigger(updatedTrigger) }, { userId }));
  })
);

/**
 * Delete a trigger (idempotent: a missing trigger is a no-op success).
 * DELETE /triggers/:id
 */
router.delete(
  '/:id',
  validate({ params: triggerIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);
    const triggerId = parseTriggerId(req.params.id);

    const triggersService = getConfiguredTriggersService();
    const trigger = await triggersService.getTrigger(userId, triggerId);

    // Tear down the EventBridge Schedule if the (existing) trigger had one.
    if (trigger?.type === 'schedule') {
      try {
        await getSchedulerService().deleteSchedule(triggerId);
        logger.info('EventBridge Schedule deleted');
      } catch (scheduleError) {
        logger.warn(
          { err: scheduleError },
          'Failed to delete EventBridge Schedule (continuing with trigger deletion):'
        );
      }
    }

    if (trigger) {
      await triggersService.deleteTrigger(userId, triggerId);
    }

    logger.info('Trigger deleted successfully (%s)', auth.requestId);

    res
      .status(200)
      .json(ok(req, { success: true, message: 'Trigger deleted' }, { userId, triggerId }));
  })
);

/**
 * Enable a trigger
 * POST /triggers/:id/enable
 */
router.post(
  '/:id/enable',
  validate({ params: triggerIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);
    const triggerId = parseTriggerId(req.params.id);

    const triggersService = getConfiguredTriggersService();
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Trigger not found');
    }

    // Toggle EventBridge FIRST, then persist `enabled` only after it succeeds.
    // Ordering it this way keeps DynamoDB and EventBridge consistent: a
    // scheduler failure aborts before the DB write, so we never end up with the
    // row marked enabled while the schedule is still disabled.
    if (trigger.type === 'schedule') {
      try {
        await getSchedulerService().enableSchedule(triggerId);
      } catch (scheduleError) {
        logger.error({ err: scheduleError }, 'Failed to enable EventBridge Schedule:');
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `Failed to enable schedule: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
          { cause: scheduleError }
        );
      }
    }

    const updatedTrigger = await triggersService.updateTrigger(userId, triggerId, {
      enabled: true,
    });

    logger.info('Trigger enabled successfully (%s)', auth.requestId);

    res.status(200).json(ok(req, { trigger: serializeTrigger(updatedTrigger) }, { userId }));
  })
);

/**
 * Disable a trigger
 * POST /triggers/:id/disable
 */
router.post(
  '/:id/disable',
  validate({ params: triggerIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);
    const triggerId = parseTriggerId(req.params.id);

    const triggersService = getConfiguredTriggersService();
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Trigger not found');
    }

    // Toggle EventBridge FIRST, then persist `enabled` only after it succeeds
    // (see the enable handler for the rationale). This matters most for
    // disable: persisting `enabled: false` before a failed `disableSchedule`
    // would leave the row "off" while the schedule keeps firing.
    if (trigger.type === 'schedule') {
      try {
        await getSchedulerService().disableSchedule(triggerId);
      } catch (scheduleError) {
        logger.error({ err: scheduleError }, 'Failed to disable EventBridge Schedule:');
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `Failed to disable schedule: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
          { cause: scheduleError }
        );
      }
    }

    const updatedTrigger = await triggersService.updateTrigger(userId, triggerId, {
      enabled: false,
    });

    logger.info('Trigger disabled successfully (%s)', auth.requestId);

    res.status(200).json(ok(req, { trigger: serializeTrigger(updatedTrigger) }, { userId }));
  })
);

/**
 * Get execution history for a trigger
 * GET /triggers/:id/executions
 */
router.get(
  '/:id/executions',
  validate({ params: triggerIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const auth = getCurrentAuth(req);
    const triggerId = parseTriggerId(req.params.id);
    const limit = parseLimit(req, 20);
    const exclusiveStartKey = decodePageToken(queryString(req.query.nextToken));

    logger.info(
      { userId, triggerId, limit, hasNextToken: !!req.query.nextToken },
      'Execution history retrieval started (%s):',
      auth.requestId
    );

    const triggersService = getConfiguredTriggersService();
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Trigger not found');
    }

    const result = await triggersService.getExecutions(triggerId, limit, exclusiveStartKey);
    const nextToken = encodePageToken(result.lastEvaluatedKey);

    logger.info(
      `Execution history retrieval completed (${auth.requestId}): ${result.executions.length} items, hasMore: ${!!nextToken}`
    );

    res.status(200).json(
      ok(
        req,
        {
          executions: result.executions.map((execution) => ({
            executionId: execution.executionId,
            triggerId: execution.triggerId,
            // Backward compatibility: old records have startedAt instead of executedAt
            executedAt:
              execution.executedAt ||
              ((execution as unknown as Record<string, unknown>).startedAt as string) ||
              '',
            sessionId: execution.sessionId,
            eventPayload: execution.eventPayload,
            errorMessage: execution.errorMessage,
          })),
          nextToken,
        },
        { userId, triggerId, count: result.executions.length }
      )
    );
  })
);

export default router;
