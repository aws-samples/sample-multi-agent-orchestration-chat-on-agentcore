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
import { type AuthenticatedRequest, requireUserId } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { createTriggerBody, updateTriggerBody } from './trigger-schemas.js';
import { getTriggersRepository } from '../repositories/triggers/triggers-repository.factory.js';
import {
  MAX_TRIGGERS_PER_USER,
  TriggerLimitExceededError,
  type Trigger,
  type TriggerType,
} from '../repositories/triggers/index.js';
import {
  getSchedulerService,
  InvalidScheduleIntervalError,
} from '../services/scheduler-service.js';
import { config } from '../config/index.js';
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
 * Project a domain Trigger into the public API shape. The repository already
 * strips DynamoDB internals (PK/SK/GSI), so this drops only the internal
 * `userId` owner key and pins the field set the API exposes — shared by every
 * endpoint that returns a trigger so the response shape cannot drift between
 * routes.
 */
function serializeTrigger(trigger: Trigger) {
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
    reasoningEffort: trigger.reasoningEffort,
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
  const service = getTriggersRepository();
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
 * Cross-field guard: an event trigger must subscribe to a source. The zod
 * `eventConfigSchema` only enforces "if eventConfig is present it carries an
 * eventSourceId" — it cannot express "type=event ⟹ eventConfig present". This
 * is the single place that rule lives for both POST (no existing record) and
 * PUT (where an unchanged `eventConfig` may already supply the source).
 *
 * Throws VALIDATION_ERROR when the resulting trigger would be an event trigger
 * with no eventSourceId. `existing` is the eventSourceId already stored on the
 * record being updated (undefined on create).
 */
function assertEventTriggerHasSource(
  resultingType: TriggerType | undefined,
  eventSourceId: string | undefined,
  existingEventSourceId?: string
): void {
  if (resultingType === 'event' && !eventSourceId && !existingEventSourceId) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      'eventConfig.eventSourceId is required for event type triggers'
    );
  }
}

/**
 * List all triggers for the authenticated user (paginated, optional ?type).
 * GET /triggers
 */
router.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);

    // Default page size = the per-user hard limit, so a user's entire trigger
    // set fits in a single page (clamped by parseLimit's MAX_PAGE_SIZE).
    const limit = parseLimit(req, MAX_TRIGGERS_PER_USER);
    const type = queryString(req.query.type);
    if (type && type !== 'schedule' && type !== 'event') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid type filter: "${type}"`);
    }
    const exclusiveStartKey = decodePageToken(queryString(req.query.nextToken));

    const result = await getConfiguredTriggersService().listTriggers(userId, {
      limit,
      type: type as TriggerType | undefined,
      exclusiveStartKey,
    });

    const nextToken = encodePageToken(result.lastEvaluatedKey);

    res
      .status(200)
      .json(
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

/**
 * Create a new trigger
 * POST /triggers
 */
router.post(
  '/',
  validate({ body: createTriggerBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const {
      name,
      description,
      type,
      agentId,
      prompt,
      sessionId,
      modelId,
      reasoningEffort,
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
    assertEventTriggerHasSource(type, eventConfig?.eventSourceId);

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
        reasoningEffort,
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
            reasoningEffort,
            workingDirectory,
            enabledTools,
          },
          targetArn,
          roleArn,
        });

        await triggersService.updateTrigger(userId, trigger.id, {
          scheduleConfig: { ...scheduleConfig, schedulerArn, scheduleGroupName: 'default' },
        });

        req.log.info({ schedulerArn }, 'EventBridge Schedule created');
      } catch (scheduleError) {
        req.log.error({ err: scheduleError }, 'Failed to create EventBridge Schedule:');
        // Rollback: delete the trigger so the DynamoDB row does not linger
        // without a backing EventBridge Schedule.
        await triggersService.deleteTrigger(userId, trigger.id);
        throw mapScheduleError(scheduleError);
      }
    }

    res.status(201).json(ok(req, { trigger: serializeTrigger(trigger) }, { userId }));
  })
);

/**
 * Update a trigger
 * PUT /triggers/:id
 */
router.put(
  '/:id',
  validate({ params: triggerIdParams, body: updateTriggerBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
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
      reasoningEffort,
      workingDirectory,
      enabledTools,
      scheduleConfig,
      eventConfig,
    } = req.body;

    const typeChanged = type && type !== existingTrigger.type;

    // Changing to (or staying) an event trigger requires a subscription. We
    // never persist an event trigger with no source (which would also leave
    // GSI2 unset). A PUT that omits eventConfig keeps the stored source.
    const resultingType = type ?? existingTrigger.type;
    assertEventTriggerHasSource(
      resultingType,
      eventConfig?.eventSourceId,
      existingTrigger.eventConfig?.eventSourceId
    );

    // Type change: schedule -> event — tear down the EventBridge Schedule.
    if (typeChanged && existingTrigger.type === 'schedule' && type === 'event') {
      req.log.info('Type change detected: schedule -> event');
      try {
        await getSchedulerService().deleteSchedule(triggerId);
        req.log.info('EventBridge Schedule deleted for type change');
      } catch (scheduleError) {
        req.log.warn(
          { err: scheduleError },
          'Failed to delete EventBridge Schedule during type change:'
        );
      }
    }

    // Type change: event -> schedule — create a new EventBridge Schedule.
    if (typeChanged && existingTrigger.type === 'event' && type === 'schedule') {
      req.log.info('Type change detected: event -> schedule');
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
            reasoningEffort:
              reasoningEffort !== undefined ? reasoningEffort : existingTrigger.reasoningEffort,
            workingDirectory:
              workingDirectory !== undefined ? workingDirectory : existingTrigger.workingDirectory,
            enabledTools: enabledTools || existingTrigger.enabledTools,
          },
          targetArn,
          roleArn,
        });
        req.log.info({ schedulerArn }, 'EventBridge Schedule created for type change');
      } catch (scheduleError) {
        req.log.error(
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
      reasoningEffort,
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
              reasoningEffort:
                reasoningEffort !== undefined ? reasoningEffort : existingTrigger.reasoningEffort,
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
        req.log.warn(
          { err: scheduleError },
          'Failed to update EventBridge Schedule (non-critical):'
        );
      }
    }

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
    const triggerId = parseTriggerId(req.params.id);

    const triggersService = getConfiguredTriggersService();
    const trigger = await triggersService.getTrigger(userId, triggerId);

    // Tear down the EventBridge Schedule if the (existing) trigger had one.
    if (trigger?.type === 'schedule') {
      try {
        await getSchedulerService().deleteSchedule(triggerId);
        req.log.info('EventBridge Schedule deleted');
      } catch (scheduleError) {
        req.log.warn(
          { err: scheduleError },
          'Failed to delete EventBridge Schedule (continuing with trigger deletion):'
        );
      }
    }

    if (trigger) {
      await triggersService.deleteTrigger(userId, triggerId);
    }

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
        req.log.error({ err: scheduleError }, 'Failed to enable EventBridge Schedule:');
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
        req.log.error({ err: scheduleError }, 'Failed to disable EventBridge Schedule:');
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
    const triggerId = parseTriggerId(req.params.id);
    const limit = parseLimit(req, 20);
    const exclusiveStartKey = decodePageToken(queryString(req.query.nextToken));

    const triggersService = getConfiguredTriggersService();
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Trigger not found');
    }

    const result = await triggersService.getExecutions(triggerId, limit, exclusiveStartKey);
    const nextToken = encodePageToken(result.lastEvaluatedKey);

    res.status(200).json(
      ok(
        req,
        {
          // `executedAt` is already normalized by the repository (it backfills
          // the legacy `startedAt` attribute on old rows), so the route just
          // projects the response fields.
          executions: result.executions.map((execution) => ({
            executionId: execution.executionId,
            triggerId: execution.triggerId,
            executedAt: execution.executedAt,
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
