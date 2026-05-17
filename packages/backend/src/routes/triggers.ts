/**
 * Triggers API endpoints
 * API for managing event-driven agent triggers
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { parseUserId, isTriggerId } from '@moca/core';
import { getTriggersDynamoDBService } from '../services/triggers-dynamodb.js';
import {
  getSchedulerService,
  InvalidScheduleIntervalError,
} from '../services/scheduler-service.js';

import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

const router = Router();

/**
 * List all triggers for the authenticated user
 * GET /triggers
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        username: auth.username,
      },
      'Triggers list retrieval started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    const triggers = await triggersService.listTriggers(userId);

    logger.info(`Triggers list retrieval completed (${auth.requestId}): ${triggers.length} items`);

    res.status(200).json({
      triggers: triggers.map((trigger) => ({
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
      })),
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
        count: triggers.length,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Triggers list retrieval error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to retrieve triggers list',
      requestId: auth.requestId,
    });
  }
});

/**
 * Get a specific trigger
 * GET /triggers/:id
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!isTriggerId(req.params.id)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: `Invalid triggerId format: "${req.params.id}"`,
        requestId: auth.requestId,
      });
    }
    const triggerId = req.params.id;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        triggerId,
      },
      'Trigger retrieval started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    const trigger = await triggersService.getTrigger(userId, triggerId);

    if (!trigger) {
      logger.warn('Trigger not found (%s): ${triggerId}', auth.requestId);
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trigger not found',
        requestId: auth.requestId,
      });
    }

    logger.info('Trigger retrieval completed (%s)', auth.requestId);

    res.status(200).json({
      trigger: {
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
      },
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Trigger retrieval error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to retrieve trigger',
      requestId: auth.requestId,
    });
  }
});

/**
 * Create a new trigger
 * POST /triggers
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
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

    // Validation
    if (!name || !type || !agentId || !prompt) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Required fields: name, type, agentId, prompt',
        requestId: auth.requestId,
      });
    }

    if (type === 'schedule' && !scheduleConfig?.expression) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'scheduleConfig.expression is required for schedule type triggers',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        name,
        type,
        agentId,
      },
      'Trigger creation started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    // Create trigger in DynamoDB
    const trigger = await triggersService.createTrigger({
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

    // If schedule type, create EventBridge Schedule
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

        // Update trigger with scheduler ARN
        await triggersService.updateTrigger(userId, trigger.id, {
          scheduleConfig: {
            ...scheduleConfig,
            schedulerArn,
            scheduleGroupName: 'default',
          },
        });

        logger.info(`EventBridge Schedule created: ${schedulerArn}`);
      } catch (scheduleError) {
        logger.error({ err: scheduleError }, 'Failed to create EventBridge Schedule:');
        // Rollback: delete the trigger so the DynamoDB row does not linger
        // without a backing EventBridge Schedule.
        await triggersService.deleteTrigger(userId, trigger.id);

        // Surface interval violations as 400 Validation Error instead of 500
        // so clients (including the UI) can display a targeted error.
        if (scheduleError instanceof InvalidScheduleIntervalError) {
          return res.status(400).json({
            error: 'Validation Error',
            code: scheduleError.code,
            message: scheduleError.message,
            requestId: auth.requestId,
          });
        }

        throw new Error(
          `Failed to create schedule: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
          { cause: scheduleError }
        );
      }
    }

    logger.info('Trigger created successfully (%s): ${trigger.id}', auth.requestId);

    res.status(201).json({
      trigger: {
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
      },
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Trigger creation error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to create trigger',
      requestId: auth.requestId,
    });
  }
});

/**
 * Update a trigger
 * PUT /triggers/:id
 */
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!isTriggerId(req.params.id)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: `Invalid triggerId format: "${req.params.id}"`,
        requestId: auth.requestId,
      });
    }
    const triggerId = req.params.id;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        triggerId,
      },
      'Trigger update started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    // Check trigger exists and user owns it
    const existingTrigger = await triggersService.getTrigger(userId, triggerId);
    if (!existingTrigger) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trigger not found',
        requestId: auth.requestId,
      });
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

    // Handle type change: schedule -> event
    if (typeChanged && existingTrigger.type === 'schedule' && type === 'event') {
      logger.info('Type change detected: schedule -> event (%s)', auth.requestId);

      // Delete existing EventBridge Schedule
      try {
        const schedulerService = getSchedulerService();
        await schedulerService.deleteSchedule(triggerId);
        logger.info(`EventBridge Schedule deleted for type change`);
      } catch (scheduleError) {
        logger.warn(
          { err: scheduleError },
          'Failed to delete EventBridge Schedule during type change:'
        );
      }
    }

    // Handle type change: event -> schedule
    if (typeChanged && existingTrigger.type === 'event' && type === 'schedule') {
      logger.info('Type change detected: event -> schedule (%s)', auth.requestId);

      if (!scheduleConfig?.expression) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'scheduleConfig.expression is required when changing to schedule type',
          requestId: auth.requestId,
        });
      }

      // Create new EventBridge Schedule
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
        if (scheduleError instanceof InvalidScheduleIntervalError) {
          return res.status(400).json({
            error: 'Validation Error',
            code: scheduleError.code,
            message: scheduleError.message,
            requestId: auth.requestId,
          });
        }
        throw new Error(
          `Failed to create schedule: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
          { cause: scheduleError }
        );
      }
    }

    // Update trigger in DynamoDB

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

    // If schedule type (and not changed from event) and schedule config changed, update EventBridge Schedule
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
        // An invalid interval on update is a client error, not a
        // best-effort side effect — surface as 400 so the UI can show a
        // targeted message instead of silently ignoring it.
        if (scheduleError instanceof InvalidScheduleIntervalError) {
          return res.status(400).json({
            error: 'Validation Error',
            code: scheduleError.code,
            message: scheduleError.message,
            requestId: auth.requestId,
          });
        }
        logger.warn(
          { err: scheduleError },
          'Failed to update EventBridge Schedule (non-critical):'
        );
      }
    }

    logger.info('Trigger updated successfully (%s)', auth.requestId);

    res.status(200).json({
      trigger: {
        id: updatedTrigger.id,
        name: updatedTrigger.name,
        description: updatedTrigger.description,
        type: updatedTrigger.type,
        enabled: updatedTrigger.enabled,
        agentId: updatedTrigger.agentId,
        prompt: updatedTrigger.prompt,
        sessionId: updatedTrigger.sessionId,
        modelId: updatedTrigger.modelId,
        workingDirectory: updatedTrigger.workingDirectory,
        enabledTools: updatedTrigger.enabledTools,
        scheduleConfig: updatedTrigger.scheduleConfig,
        eventConfig: updatedTrigger.eventConfig,
        createdAt: updatedTrigger.createdAt,
        updatedAt: updatedTrigger.updatedAt,
        lastExecutedAt: updatedTrigger.lastExecutedAt,
      },
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Trigger update error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to update trigger',
      requestId: auth.requestId,
    });
  }
});

/**
 * Delete a trigger
 * DELETE /triggers/:id
 */
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!isTriggerId(req.params.id)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: `Invalid triggerId format: "${req.params.id}"`,
        requestId: auth.requestId,
      });
    }
    const triggerId = req.params.id;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        triggerId,
      },
      'Trigger deletion started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    // Check trigger exists and user owns it
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trigger not found',
        requestId: auth.requestId,
      });
    }

    // Delete EventBridge Schedule if exists
    if (trigger.type === 'schedule') {
      try {
        const schedulerService = getSchedulerService();
        await schedulerService.deleteSchedule(triggerId);
        logger.info(`EventBridge Schedule deleted`);
      } catch (scheduleError) {
        logger.warn(
          { err: scheduleError },
          'Failed to delete EventBridge Schedule (continuing with trigger deletion):'
        );
      }
    }

    // Delete trigger from DynamoDB
    await triggersService.deleteTrigger(userId, triggerId);

    logger.info('Trigger deleted successfully (%s)', auth.requestId);

    res.status(200).json({
      success: true,
      message: 'Trigger deleted',
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
        triggerId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Trigger deletion error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to delete trigger',
      requestId: auth.requestId,
    });
  }
});

/**
 * Enable a trigger
 * POST /triggers/:id/enable
 */
router.post('/:id/enable', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!isTriggerId(req.params.id)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: `Invalid triggerId format: "${req.params.id}"`,
        requestId: auth.requestId,
      });
    }
    const triggerId = req.params.id;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        triggerId,
      },
      '▶️ Trigger enable started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    // Check trigger exists and user owns it
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trigger not found',
        requestId: auth.requestId,
      });
    }

    // Update trigger status
    const updatedTrigger = await triggersService.updateTrigger(userId, triggerId, {
      enabled: true,
    });

    // Enable EventBridge Schedule if exists
    if (trigger.type === 'schedule') {
      try {
        const schedulerService = getSchedulerService();
        await schedulerService.enableSchedule(triggerId);
      } catch (scheduleError) {
        logger.error({ err: scheduleError }, 'Failed to enable EventBridge Schedule:');
        throw new Error(
          `Failed to enable schedule: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
          { cause: scheduleError }
        );
      }
    }

    logger.info('Trigger enabled successfully (%s)', auth.requestId);

    res.status(200).json({
      trigger: {
        id: updatedTrigger.id,
        name: updatedTrigger.name,
        description: updatedTrigger.description,
        type: updatedTrigger.type,
        enabled: updatedTrigger.enabled,
        agentId: updatedTrigger.agentId,
        prompt: updatedTrigger.prompt,
        sessionId: updatedTrigger.sessionId,
        modelId: updatedTrigger.modelId,
        workingDirectory: updatedTrigger.workingDirectory,
        enabledTools: updatedTrigger.enabledTools,
        scheduleConfig: updatedTrigger.scheduleConfig,
        eventConfig: updatedTrigger.eventConfig,
        createdAt: updatedTrigger.createdAt,
        updatedAt: updatedTrigger.updatedAt,
        lastExecutedAt: updatedTrigger.lastExecutedAt,
      },
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Trigger enable error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to enable trigger',
      requestId: auth.requestId,
    });
  }
});

/**
 * Disable a trigger
 * POST /triggers/:id/disable
 */
router.post('/:id/disable', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!isTriggerId(req.params.id)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: `Invalid triggerId format: "${req.params.id}"`,
        requestId: auth.requestId,
      });
    }
    const triggerId = req.params.id;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        triggerId,
      },
      'Trigger disable started (%s):',
      auth.requestId
    );

    const triggersService = getTriggersDynamoDBService();

    if (!triggersService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Triggers Table is not configured',
        requestId: auth.requestId,
      });
    }

    // Check trigger exists and user owns it
    const trigger = await triggersService.getTrigger(userId, triggerId);
    if (!trigger) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Trigger not found',
        requestId: auth.requestId,
      });
    }

    // Update trigger status
    const updatedTrigger = await triggersService.updateTrigger(userId, triggerId, {
      enabled: false,
    });

    // Disable EventBridge Schedule if exists
    if (trigger.type === 'schedule') {
      try {
        const schedulerService = getSchedulerService();
        await schedulerService.disableSchedule(triggerId);
      } catch (scheduleError) {
        logger.error({ err: scheduleError }, 'Failed to disable EventBridge Schedule:');
        throw new Error(
          `Failed to disable schedule: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}`,
          { cause: scheduleError }
        );
      }
    }

    logger.info('Trigger disabled successfully (%s)', auth.requestId);

    res.status(200).json({
      trigger: {
        id: updatedTrigger.id,
        name: updatedTrigger.name,
        description: updatedTrigger.description,
        type: updatedTrigger.type,
        enabled: updatedTrigger.enabled,
        agentId: updatedTrigger.agentId,
        prompt: updatedTrigger.prompt,
        sessionId: updatedTrigger.sessionId,
        modelId: updatedTrigger.modelId,
        workingDirectory: updatedTrigger.workingDirectory,
        enabledTools: updatedTrigger.enabledTools,
        scheduleConfig: updatedTrigger.scheduleConfig,
        eventConfig: updatedTrigger.eventConfig,
        createdAt: updatedTrigger.createdAt,
        updatedAt: updatedTrigger.updatedAt,
        lastExecutedAt: updatedTrigger.lastExecutedAt,
      },
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Trigger disable error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to disable trigger',
      requestId: auth.requestId,
    });
  }
});

/**
 * Get execution history for a trigger
 * GET /triggers/:id/executions
 */
router.get(
  '/:id/executions',

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const userId = auth.userId ? parseUserId(auth.userId) : undefined;

      if (!isTriggerId(req.params.id)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `Invalid triggerId format: "${req.params.id}"`,
          requestId: auth.requestId,
        });
      }
      const triggerId = req.params.id;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const nextToken = req.query.nextToken as string | undefined;

      if (!userId) {
        return res.status(400).json({
          error: 'Invalid authentication',
          message: 'Failed to retrieve user ID',
          requestId: auth.requestId,
        });
      }

      logger.info(
        {
          userId,
          triggerId,
          limit,
          hasNextToken: !!nextToken,
        },
        'Execution history retrieval started (%s):',
        auth.requestId
      );

      const triggersService = getTriggersDynamoDBService();

      if (!triggersService.isConfigured()) {
        return res.status(500).json({
          error: 'Configuration Error',
          message: 'Triggers Table is not configured',
          requestId: auth.requestId,
        });
      }

      // Check trigger exists and user owns it
      const trigger = await triggersService.getTrigger(userId, triggerId);
      if (!trigger) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Trigger not found',
          requestId: auth.requestId,
        });
      }

      // Decode nextToken if provided
      let exclusiveStartKey: Record<string, unknown> | undefined;
      if (nextToken) {
        try {
          exclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8'));
        } catch {
          return res.status(400).json({
            error: 'Invalid Parameter',
            message: 'Invalid nextToken format',
            requestId: auth.requestId,
          });
        }
      }

      const result = await triggersService.getExecutions(triggerId, limit, exclusiveStartKey);

      // Encode lastEvaluatedKey as nextToken
      const responseNextToken = result.lastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64')
        : undefined;

      logger.info(
        `Execution history retrieval completed (${auth.requestId}): ${result.executions.length} items, hasMore: ${!!responseNextToken}`
      );

      res.status(200).json({
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
        nextToken: responseNextToken,
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          userId,
          triggerId,
          count: result.executions.length,
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error({ err: error }, 'Execution history retrieval error (%s):', auth.requestId);

      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to retrieve execution history',
        requestId: auth.requestId,
      });
    }
  }
);

export default router;
