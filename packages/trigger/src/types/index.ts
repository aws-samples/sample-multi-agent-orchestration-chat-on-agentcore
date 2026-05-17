/**
 * Trigger type definitions
 * These types define the data models for event-driven agent invocations
 */

import type { TriggerId } from '@moca/core';

/**
 * Trigger type - supports extensibility for future trigger sources
 */
export type TriggerType = 'schedule' | 'event';

/**
 * Schedule configuration for schedule-type triggers
 */
export interface ScheduleTriggerConfig {
  /**
   * Cron expression (e.g., "cron(0 12 * * ? *)") or rate expression (e.g., "rate(1 hour)")
   */
  expression: string;

  /**
   * Timezone for cron expression (e.g., "Asia/Tokyo")
   * @default "UTC"
   */
  timezone?: string;

  /**
   * EventBridge Scheduler ARN
   */
  schedulerArn?: string;

  /**
   * EventBridge Scheduler Group Name
   */
  scheduleGroupName?: string;
}

/**
 * Event configuration for event-type triggers
 */
export interface EventTriggerConfig {
  /**
   * Event source ID (e.g., "s3-upload", "github-pr")
   */
  eventSourceId?: string;

  /**
   * EventBridge Bus name (e.g., "default", custom bus name)
   */
  eventBusName?: string;

  /**
   * EventBridge event pattern for filtering
   */
  eventPattern?: Record<string, unknown>;

  /**
   * EventBridge Rule ARN
   */
  ruleArn?: string;
}

/**
 * Main Trigger entity
 */
export interface Trigger {
  // DynamoDB Keys
  PK: string; // TRIGGER#{userId}
  SK: string; // TRIGGER#{triggerId}

  // Basic information
  id: TriggerId;
  userId: string;
  name: string;
  description?: string;
  type: TriggerType;
  enabled: boolean;

  // Agent invocation parameters
  agentId: string;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];

  // Type-specific configuration
  scheduleConfig?: ScheduleTriggerConfig;
  eventConfig?: EventTriggerConfig;

  // Metadata
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;

  // GSI for listing by type
  GSI1PK?: string; // TYPE#{type}
  GSI1SK?: string; // USER#{userId}#{triggerId}
}

/**
 * Trigger execution history record
 * Simplified to track execution facts only (no status management)
 */
export interface TriggerExecution {
  // DynamoDB Keys
  PK: string; // TRIGGER#{triggerId}
  SK: string; // EXECUTION#{executionId}

  triggerId: TriggerId;
  executionId: string;

  /** Execution timestamp (ISO 8601) */
  executedAt: string;

  /** Agent session ID for linking to session details */
  sessionId?: string;

  /** EventBridge event payload (JSON string, truncated to ~10KB) */
  eventPayload?: string;

  /** Error message when invocation failed (undefined = success) */
  errorMessage?: string;

  // TTL for auto-cleanup (30 days)
  ttl: number;
}

/**
 * Request body for creating/updating triggers
 */
export interface CreateTriggerRequest {
  name: string;
  description?: string;
  type: TriggerType;
  agentId: string;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: Omit<ScheduleTriggerConfig, 'schedulerArn' | 'scheduleGroupName'>;
  eventConfig?: Omit<EventTriggerConfig, 'ruleArn'>;
}

/**
 * Request body for updating triggers
 */
export interface UpdateTriggerRequest extends Partial<CreateTriggerRequest> {
  enabled?: boolean;
}

/**
 * Response for trigger API
 */
export interface TriggerResponse {
  id: TriggerId;
  userId: string;
  name: string;
  description?: string;
  type: TriggerType;
  enabled: boolean;
  agentId: string;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: ScheduleTriggerConfig;
  eventConfig?: EventTriggerConfig;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
}

/**
 * Response for trigger execution history
 */
export interface TriggerExecutionResponse {
  triggerId: TriggerId;
  executionId: string;
  executedAt: string;
  sessionId?: string;
  eventPayload?: string;
  errorMessage?: string;
}

/**
 * EventBridge Scheduler event payload
 */
export interface SchedulerEventPayload {
  triggerId: TriggerId;
  userId: string;
  agentId: string;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
}

/**
 * EventBridge Scheduler event structure
 * This is the event format sent by EventBridge Scheduler to Lambda
 */
export interface SchedulerEvent {
  version: string;
  id: string;
  'detail-type': string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: SchedulerEventPayload;
}

/**
 * EventBridge custom event (S3, GitHub, Slack, etc.)
 * This is the standard EventBridge event structure for custom rules
 */
export interface CustomEventBridgeEvent {
  version: string;
  id: string;
  'detail-type': string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: Record<string, unknown>;
}

/**
 * Generic event-driven context for any EventBridge event
 * This structure supports arbitrary event sources without requiring source-specific interfaces
 */
export interface EventDrivenContext {
  // Execution Metadata
  /** Trigger ID from the application */
  triggerId: TriggerId;

  /** Human-readable trigger name */
  triggerName?: string;

  /** Actual execution timestamp (ISO 8601) */
  executionTime: string;

  // EventBridge Standard Fields
  eventBridge: {
    /** Unique event ID */
    id: string;

    /** Event source (e.g., "aws.scheduler", "custom.slack", "com.github") */
    source: string;

    /** Event type (e.g., "Scheduled Event", "Pull Request", "Message Posted") */
    detailType: string;

    /** AWS account ID */
    account: string;

    /** AWS region */
    region: string;

    /** Event timestamp from EventBridge */
    time: string;

    /** Associated AWS resources */
    resources: string[];
  };

  // Event Payload (Schema-less)
  /**
   * Raw event detail - structure depends on event source
   * Could be Slack message, GitHub webhook, S3 event, custom payload, etc.
   */
  eventDetail: Record<string, unknown>;
}
