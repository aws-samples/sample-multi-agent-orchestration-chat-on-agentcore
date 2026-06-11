/**
 * `TriggersRepository` — the behaviour contract for trigger persistence.
 *
 * THIS FILE IS THE WHOLE PUBLIC SURFACE. To *use* triggers you only need this
 * interface plus the domain types in `./types.ts`; you never need to open the
 * `./dynamodb/` implementation. Routes and services depend on this interface,
 * not on a concrete class, so the storage engine can be swapped (a second
 * implementation, an in-memory fake for unit tests) without touching callers.
 *
 * Contract notes that hold for ANY implementation:
 * - Methods speak only domain {@link Trigger} values — never storage rows.
 * - `userId` scopes every per-user operation; a trigger is addressed by
 *   `(userId, triggerId)`.
 * - Reads of a missing trigger return `null` (get) or an empty list, never throw.
 */

import type { UserId, AgentId, TriggerId, ReasoningDepth } from '@moca/core';
import type { Trigger, TriggerType, TriggerExecution, ScheduleTriggerConfig, EventTriggerConfig } from './types.js';

// --- Method input/output types ----------------------------------------------
// These describe how you OPERATE on triggers (the arguments and return shapes
// of the methods below), as opposed to the domain MODEL in `./types.ts`. They
// live here because each only makes sense paired with its method, so reading
// the interface gives you everything needed to call it.

export interface CreateTriggerInput {
  userId: UserId;
  name: string;
  description?: string;
  type: TriggerType;
  agentId: AgentId;
  prompt: string;
  sessionId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningDepth;
  workingDirectory?: string;
  enabledTools?: string[];
  scheduleConfig?: Omit<ScheduleTriggerConfig, 'schedulerArn' | 'scheduleGroupName'>;
  eventConfig?: Omit<EventTriggerConfig, 'ruleArn'>;
}

export interface UpdateTriggerInput {
  name?: string;
  description?: string;
  type?: TriggerType;
  agentId?: string;
  prompt?: string;
  sessionId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningDepth;
  workingDirectory?: string;
  enabledTools?: string[];
  enabled?: boolean;
  scheduleConfig?: Partial<ScheduleTriggerConfig>;
  eventConfig?: Partial<EventTriggerConfig>;
}

/** Options for {@link TriggersRepository.listTriggers}. */
export interface ListTriggersOptions {
  limit?: number;
  type?: TriggerType;
  exclusiveStartKey?: Record<string, unknown>;
}

export interface ListTriggersResult {
  triggers: Trigger[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface GetExecutionsResult {
  executions: TriggerExecution[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface TriggersRepository {
  /**
   * Whether the repository is wired to a backing store. Routes call this to
   * short-circuit with a CONFIGURATION_ERROR before invoking data methods, so
   * the data methods themselves may assume a configured store.
   */
  isConfigured(): boolean;

  /**
   * Count the triggers owned by a user (no item payload). Backs the per-user
   * {@link MAX_TRIGGERS_PER_USER} limit; counts trigger records only, not
   * execution-history rows.
   */
  countTriggers(userId: UserId): Promise<number>;

  /**
   * Create a new trigger for `input.userId`.
   * @throws TriggerLimitExceededError when the user is already at
   * {@link MAX_TRIGGERS_PER_USER}.
   */
  createTrigger(input: CreateTriggerInput): Promise<Trigger>;

  /** Get a trigger by id, or `null` if the user has no such trigger. */
  getTrigger(userId: UserId, triggerId: TriggerId): Promise<Trigger | null>;

  /**
   * List a user's triggers, newest-relevant first, with optional `type` filter
   * and opaque-key pagination (see {@link ListTriggersOptions}).
   */
  listTriggers(userId: UserId, options?: ListTriggersOptions): Promise<ListTriggersResult>;

  /**
   * Apply a partial update and return the resulting trigger. Always refreshes
   * `updatedAt`; keeps any derived indexing consistent with the new state.
   * @throws Error when the trigger does not exist.
   */
  updateTrigger(
    userId: UserId,
    triggerId: TriggerId,
    updates: UpdateTriggerInput
  ): Promise<Trigger>;

  /** Delete a trigger. Deleting a missing trigger is a no-op (idempotent). */
  deleteTrigger(userId: UserId, triggerId: TriggerId): Promise<void>;

  /** List every trigger subscribed to a given event source. */
  listTriggersByEventSource(eventSourceId: string): Promise<Trigger[]>;

  /**
   * Get a trigger's execution history, most-recent first, with opaque-key
   * pagination.
   */
  getExecutions(
    triggerId: TriggerId,
    limit?: number,
    exclusiveStartKey?: Record<string, unknown>
  ): Promise<GetExecutionsResult>;
}
