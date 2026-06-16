/**
 * EventBridge Scheduler Service
 * Manages EventBridge Schedules for trigger automation
 */

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
} from '@aws-sdk/client-scheduler';
import type { UserId, AgentId, TriggerId, ReasoningDepth } from '@moca/core';
import { config as appConfig } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

/**
 * Schedule payload for Lambda invocation
 */
export interface SchedulePayload {
  triggerId: TriggerId;
  userId: UserId;
  agentId: AgentId;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningDepth;
  workingDirectory?: string;
  enabledTools?: string[];
}

/**
 * Schedule configuration
 */
export interface ScheduleConfig {
  name: string;
  expression: string;
  timezone?: string;
  payload: SchedulePayload;
  targetArn: string;
  roleArn: string;
  enabled?: boolean;
}

/**
 * Format schedule expression for EventBridge Scheduler
 * Wraps cron expressions with cron() and passes through rate expressions
 */
function formatScheduleExpression(expression: string): string {
  const trimmed = expression.trim();

  // If already wrapped, return as-is
  if (trimmed.startsWith('cron(') || trimmed.startsWith('rate(')) {
    return trimmed;
  }

  // If starts with 'rate', wrap with rate()
  if (trimmed.startsWith('rate ')) {
    return `rate(${trimmed.substring(5)})`;
  }

  // Otherwise, treat as cron expression
  return `cron(${trimmed})`;
}

/**
 * Hard minimum interval (in minutes). Schedules below this are rejected so
 * that a single user — or a small group sharing a cron pattern — cannot
 * exhaust the `GetOpenIdTokenForDeveloperIdentity` 25 TPS hard quota at
 * event-fire time, and to bound the per-fire cost (Lambda + Bedrock) of
 * high-frequency schedules. Schedules between this floor and
 * `COST_WARNING_THRESHOLD_MINUTES` are still allowed but the frontend
 * surfaces a cost warning with explicit confirmation.
 */
const MINIMUM_INTERVAL_MINUTES = 10;

/**
 * Thrown when a schedule expression fires more frequently than
 * MINIMUM_INTERVAL_MINUTES. Routes map this to HTTP 400.
 */
export class InvalidScheduleIntervalError extends Error {
  readonly code = 'INVALID_SCHEDULE_INTERVAL';
  constructor(expression: string, intervalMinutes: number) {
    super(
      `Schedule interval must be at least ${MINIMUM_INTERVAL_MINUTES} minutes ` +
        `(got ~${intervalMinutes.toFixed(2)} min for "${expression}")`
    );
    this.name = 'InvalidScheduleIntervalError';
  }
}

/**
 * Estimate the minimum interval (in minutes) between executions of the
 * given schedule expression. Supports both `cron(...)` (6 fields) and
 * `rate(N unit)` expressions. Returns `null` when the expression cannot
 * be parsed.
 *
 * IMPORTANT: This function has a mirrored copy in the frontend at
 * `packages/frontend/src/components/triggers/CronBuilder/cronUtils.ts`
 * (`getMinimumIntervalMinutes`). When changing the logic here, apply the
 * same change there to keep UI and API validation in sync — the frontend
 * uses it for immediate error/warning feedback, while the backend uses
 * it as the authoritative rejection gate.
 */
function getMinimumIntervalMinutes(expression: string): number | null {
  const trimmed = expression.trim();

  // rate(N unit) or "rate N unit"
  const rateMatch = trimmed.match(
    /^(?:rate\(|rate\s+)(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)\)?$/i
  );
  if (rateMatch) {
    const value = parseFloat(rateMatch[1]);
    const unit = rateMatch[2].toLowerCase().replace(/s$/, '');
    switch (unit) {
      case 'second':
        return value / 60;
      case 'minute':
        return value;
      case 'hour':
        return value * 60;
      case 'day':
        return value * 60 * 24;
      default:
        return null;
    }
  }

  // Strip surrounding cron(...) wrapper if present.
  const cronBody = trimmed.replace(/^cron\(|\)$/g, '').trim();
  const parts = cronBody.split(/\s+/);
  if (parts.length !== 6) return null;

  const [minute, hour] = parts;
  const minuteGap = deriveMinuteGap(minute);
  if (minuteGap === null) return null;

  const hourGap = deriveHourGap(hour);
  if (hourGap === null) return null;

  if (minuteGap === 60) {
    return hourGap * 60;
  }
  if (hourGap > 1) {
    return hourGap * 60;
  }
  return minuteGap;
}

function deriveMinuteGap(minute: string): number | null {
  if (minute === '*') return 1;

  const stepMatch = minute.match(/^(\*|\d+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    if (!Number.isFinite(step) || step <= 0) return null;
    return step;
  }

  if (minute.includes(',')) {
    const values = minute.split(',').map((v) => parseInt(v, 10));
    if (values.some((v) => !Number.isFinite(v))) return null;
    const sorted = [...values].sort((a, b) => a - b);
    let minGap = 60;
    for (let i = 1; i < sorted.length; i++) {
      minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
    }
    minGap = Math.min(minGap, 60 - sorted[sorted.length - 1] + sorted[0]);
    return minGap;
  }

  if (minute.includes('-')) {
    const [start, end] = minute.split('-').map((v) => parseInt(v, 10));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return 1;
  }

  if (/^\d+$/.test(minute)) return 60;

  return null;
}

function deriveHourGap(hour: string): number | null {
  if (hour === '*') return 1;

  const stepMatch = hour.match(/^(\*|\d+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    if (!Number.isFinite(step) || step <= 0) return null;
    return step;
  }

  if (hour.includes(',')) {
    const values = hour.split(',').map((v) => parseInt(v, 10));
    if (values.some((v) => !Number.isFinite(v))) return null;
    const sorted = [...values].sort((a, b) => a - b);
    let minGap = 24;
    for (let i = 1; i < sorted.length; i++) {
      minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
    }
    minGap = Math.min(minGap, 24 - sorted[sorted.length - 1] + sorted[0]);
    return minGap;
  }

  if (hour.includes('-')) return 1;
  if (/^\d+$/.test(hour)) return 24;

  return null;
}

/**
 * Assert the given schedule expression fires no more frequently than once
 * per `MINIMUM_INTERVAL_MINUTES`. Throws `InvalidScheduleIntervalError`
 * otherwise. Unparseable expressions are allowed through — EventBridge
 * itself will reject them with its own validation error, which we surface
 * unchanged to the user.
 */
function assertMinimumInterval(expression: string): void {
  const minutes = getMinimumIntervalMinutes(expression);
  if (minutes === null) return;
  if (minutes < MINIMUM_INTERVAL_MINUTES) {
    throw new InvalidScheduleIntervalError(expression, minutes);
  }
}

/**
 * Number of retries EventBridge Scheduler performs on a failed target
 * invocation. Triggers are idempotent-at-most-once by design (a missed fire is
 * preferable to a duplicate agent run), so retries are disabled everywhere.
 */
const NO_RETRY: { MaximumRetryAttempts: number } = { MaximumRetryAttempts: 0 };

/**
 * Build the EventBridge event envelope handed to the target as `Target.Input`.
 * The Trigger Lambda receives this verbatim and reads `detail` as the
 * {@link SchedulePayload}. Create and update share this single builder so the
 * two code paths can never drift in envelope shape.
 */
function buildTargetInput(triggerId: TriggerId, payload: SchedulePayload): string {
  return JSON.stringify({
    version: '0',
    id: `trigger-${triggerId}`,
    'detail-type': 'Scheduled Event',
    source: 'agentcore.trigger',
    time: new Date().toISOString(),
    region: appConfig.AWS_REGION,
    resources: [],
    detail: payload,
  });
}

/**
 * EventBridge Scheduler Service
 */
export class SchedulerService {
  private readonly client: SchedulerClient;
  private readonly scheduleGroupName: string;

  constructor(region?: string, scheduleGroupName: string = 'default') {
    this.client = new SchedulerClient({
      region: region || appConfig.AWS_REGION,
    });
    this.scheduleGroupName = scheduleGroupName;
  }

  /**
   * Create a new schedule
   */
  async createSchedule(config: ScheduleConfig): Promise<string> {
    const scheduleName = `trigger-${config.payload.triggerId}`;

    // Enforce minimum interval BEFORE calling EventBridge so we surface a
    // well-typed domain error (`InvalidScheduleIntervalError`) that the HTTP
    // route layer can map to a 400 response, rather than a raw 500 wrapped
    // around a generic AWS SDK failure.
    assertMinimumInterval(config.expression);

    logger.info(
      {
        name: scheduleName,
        expression: config.expression,
        timezone: config.timezone,
        triggerId: config.payload.triggerId,
      },
      'Creating EventBridge Schedule:'
    );

    try {
      const command = new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: this.scheduleGroupName,
        ScheduleExpression: formatScheduleExpression(config.expression),
        ScheduleExpressionTimezone: config.timezone || 'UTC',
        State: config.enabled === false ? 'DISABLED' : 'ENABLED',
        FlexibleTimeWindow: {
          Mode: 'OFF',
        },
        Target: {
          Arn: config.targetArn,
          RoleArn: config.roleArn,
          RetryPolicy: NO_RETRY,
          Input: buildTargetInput(config.payload.triggerId, config.payload),
        },
      });

      await this.client.send(command);

      const scheduleArn = `arn:aws:scheduler:${appConfig.AWS_REGION}:${appConfig.AWS_ACCOUNT_ID}:schedule/${this.scheduleGroupName}/${scheduleName}`;

      logger.info(
        {
          name: scheduleName,
          arn: scheduleArn,
        },
        'Schedule created successfully:'
      );

      return scheduleArn;
    } catch (error) {
      logger.error({ err: error }, 'Failed to create schedule:');
      throw new Error(
        `Failed to create EventBridge schedule: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Update an existing schedule
   */
  async updateSchedule(triggerId: TriggerId, config: Partial<ScheduleConfig>): Promise<void> {
    const scheduleName = `trigger-${triggerId}`;

    // Validate the new expression only when it is actually changing. Omitting
    // `expression` means "keep the current schedule"; no need to re-check
    // something that was already accepted at creation time.
    if (config.expression !== undefined) {
      assertMinimumInterval(config.expression);
    }

    logger.info(
      {
        name: scheduleName,
        expression: config.expression,
        timezone: config.timezone,
      },
      'Updating EventBridge Schedule:'
    );

    try {
      // Get current schedule to merge with updates
      const getCommand = new GetScheduleCommand({
        Name: scheduleName,
        GroupName: this.scheduleGroupName,
      });
      const currentSchedule = await this.client.send(getCommand);

      const command = new UpdateScheduleCommand({
        Name: scheduleName,
        GroupName: this.scheduleGroupName,
        ScheduleExpression: config.expression
          ? formatScheduleExpression(config.expression)
          : currentSchedule.ScheduleExpression,
        ScheduleExpressionTimezone:
          config.timezone || currentSchedule.ScheduleExpressionTimezone || 'UTC',
        State:
          config.enabled === false
            ? 'DISABLED'
            : config.enabled === true
              ? 'ENABLED'
              : currentSchedule.State,
        FlexibleTimeWindow: {
          Mode: 'OFF',
        },
        // With a new payload, rebuild the target through the shared builder so
        // it matches createSchedule exactly. Without one (a pure pause/resume
        // or expression edit), preserve the existing target and only re-pin the
        // retry policy.
        Target: config.payload
          ? {
              Arn: config.targetArn || currentSchedule.Target!.Arn,
              RoleArn: config.roleArn || currentSchedule.Target!.RoleArn,
              RetryPolicy: NO_RETRY,
              Input: buildTargetInput(triggerId, config.payload),
            }
          : {
              Arn: currentSchedule.Target!.Arn!,
              RoleArn: currentSchedule.Target!.RoleArn!,
              ...currentSchedule.Target,
              RetryPolicy: NO_RETRY,
            },
      });

      await this.client.send(command);

      logger.info({ name: scheduleName }, 'Schedule updated successfully:');
    } catch (error) {
      logger.error({ err: error }, 'Failed to update schedule:');
      throw new Error(
        `Failed to update EventBridge schedule: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Delete a schedule
   */
  async deleteSchedule(triggerId: TriggerId): Promise<void> {
    const scheduleName = `trigger-${triggerId}`;

    logger.info({ name: scheduleName }, 'Deleting EventBridge Schedule:');

    try {
      const command = new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: this.scheduleGroupName,
      });

      await this.client.send(command);

      logger.info({ name: scheduleName }, 'Schedule deleted successfully:');
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete schedule:');
      throw new Error(
        `Failed to delete EventBridge schedule: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Enable a schedule
   */
  async enableSchedule(triggerId: TriggerId): Promise<void> {
    await this.updateSchedule(triggerId, { enabled: true });
    logger.info({ triggerId }, 'Schedule enabled:');
  }

  /**
   * Disable a schedule
   */
  async disableSchedule(triggerId: TriggerId): Promise<void> {
    await this.updateSchedule(triggerId, { enabled: false });
    logger.info({ triggerId }, 'Schedule disabled:');
  }

  /**
   * Check if a schedule exists
   */
  async scheduleExists(triggerId: TriggerId): Promise<boolean> {
    const scheduleName = `trigger-${triggerId}`;

    try {
      const command = new GetScheduleCommand({
        Name: scheduleName,
        GroupName: this.scheduleGroupName,
      });

      await this.client.send(command);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        return false;
      }
      throw error;
    }
  }
}

// Singleton instance
let schedulerServiceInstance: SchedulerService | null = null;

/**
 * Get or create SchedulerService instance
 */
export function getSchedulerService(): SchedulerService {
  if (!schedulerServiceInstance) {
    schedulerServiceInstance = new SchedulerService(
      appConfig.AWS_REGION,
      appConfig.SCHEDULE_GROUP_NAME
    );
  }
  return schedulerServiceInstance;
}
