/**
 * Trigger domain MODEL — what a trigger *is*, independent of how you operate on
 * it. These are the types you reach for to read or hold a trigger value:
 * `Trigger` and its nested config shapes, `TriggerExecution`, the per-user
 * limit, and its error.
 *
 * The repository's method input/output types (`CreateTriggerInput`,
 * `UpdateTriggerInput`, `ListTriggersOptions`, the `*Result` shapes) live with
 * the `TriggersRepository` interface in `./triggers-repository.ts`, not here:
 * they only make sense alongside the method they feed, so co-locating them
 * keeps this file to the data model and shrinks what a caller has to scan.
 *
 * These types describe the DOMAIN only. They deliberately carry NO DynamoDB
 * storage details (no `PK`/`SK`/`GSI*` keys): how a trigger is keyed and
 * indexed is an implementation detail private to `./dynamodb/` (see
 * `item.ts`). Adding/altering an index never ripples into route or service code.
 */

import type { UserId, AgentId, TriggerId, ReasoningDepth } from '@moca/core';

/**
 * Maximum number of triggers a single user may register.
 *
 * This is an intentional, explicit hard limit (not an incidental page size):
 * it bounds per-user EventBridge Schedule / rule fan-out and keeps the trigger
 * list returnable in a single page. The triggers list endpoint uses this same
 * value as its default page size so the whole set fits in one response.
 */
export const MAX_TRIGGERS_PER_USER = 20;

/**
 * Thrown by `createTrigger` when the user already holds
 * `MAX_TRIGGERS_PER_USER` triggers. Routes map this to HTTP 409 Conflict.
 */
export class TriggerLimitExceededError extends Error {
  readonly code = 'TRIGGER_LIMIT_EXCEEDED';
  readonly limit = MAX_TRIGGERS_PER_USER;
  constructor() {
    super(`Trigger limit reached (maximum ${MAX_TRIGGERS_PER_USER} per user)`);
    this.name = 'TriggerLimitExceededError';
  }
}

/**
 * Trigger type definitions (matching trigger package)
 */
export type TriggerType = 'schedule' | 'event';

export interface ScheduleTriggerConfig {
  expression: string;
  timezone?: string;
  schedulerArn?: string;
  scheduleGroupName?: string;
}

export interface EventTriggerConfig {
  eventSourceId?: string;
  eventBusName?: string;
  eventPattern?: Record<string, unknown>;
  ruleArn?: string;
}

/**
 * A trigger as the rest of the application sees it: a flat domain record with
 * no storage keys. This is what every repository method returns.
 */
export interface Trigger {
  id: TriggerId;
  userId: UserId;
  name: string;
  description?: string;
  type: TriggerType;
  enabled: boolean;
  agentId: AgentId;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  /** Extended-thinking depth used when this trigger invokes the agent. */
  reasoningEffort?: ReasoningDepth;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: ScheduleTriggerConfig;
  eventConfig?: EventTriggerConfig;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
}

export interface TriggerExecution {
  triggerId: TriggerId;
  executionId: string;
  executedAt: string;
  sessionId?: string;
  eventPayload?: string;
  errorMessage?: string;
  ttl: number;
}
