/**
 * Trigger types for frontend
 */

import type { AgentId, SessionId, TriggerId, UserId } from '@moca/core';

export type TriggerType = 'schedule' | 'event';
export type TriggerStatus = 'enabled' | 'disabled';

export interface Trigger {
  /** Branded trigger identifier (UUID), kept in sync with backend `TriggerId`. */
  id: TriggerId;
  /** Owner of this trigger. Branded so it cannot be confused with `AgentId`. */
  userId: UserId;
  name: string;
  description?: string;
  /** The agent this trigger invokes. */
  agentId: AgentId;
  type: TriggerType;
  enabled: boolean;
  prompt: string;
  /**
   * Optional target session; when set, the trigger appends to this session
   * instead of creating a new one. Branded `SessionId` so it satisfies
   * AgentCore Runtime's 33-char alphanumeric constraint at the type level.
   */
  sessionId?: SessionId;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: ScheduleConfig;
  eventConfig?: EventConfig;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
}

export interface ScheduleConfig {
  expression: string;
  timezone?: string;
  schedulerArn?: string;
  scheduleGroupName?: string;
}

export interface EventConfig {
  eventSourceId: string;
  eventSource?: string;
  eventPattern?: Record<string, unknown>;
}

export interface ExecutionRecord {
  executionId: string;
  triggerId: TriggerId;
  executedAt: string;
  sessionId?: SessionId;
  eventPayload?: string;
  errorMessage?: string;
}

export interface CreateTriggerRequest {
  name: string;
  description?: string;
  agentId: AgentId;
  type: TriggerType;
  prompt: string;
  sessionId?: SessionId;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: ScheduleConfig;
  eventConfig?: EventConfig;
}

export interface UpdateTriggerRequest {
  name?: string;
  description?: string;
  agentId?: AgentId;
  type?: TriggerType;
  prompt?: string;
  sessionId?: SessionId;
  modelId?: string;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: ScheduleConfig;
  eventConfig?: EventConfig;
}

export interface ListTriggersResponse {
  triggers: Trigger[];
  nextToken?: string;
}

export interface ListExecutionsResponse {
  executions: ExecutionRecord[];
  nextToken?: string;
}
