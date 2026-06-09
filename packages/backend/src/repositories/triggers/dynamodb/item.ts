/**
 * DynamoDB storage mapping for triggers — IMPLEMENTATION DETAIL.
 *
 * Everything that knows the single-table layout (the `PK`/`SK` keys, the
 * `GSI*` projection keys, and the dynamic UpdateExpression) lives here and
 * nowhere else. Callers of the repository never import this module; it exists
 * so the rest of the codebase can stay in terms of the domain {@link Trigger}.
 */

import type { UserId, TriggerId } from '@moca/core';
import { pick } from '../../../libs/object/index.js';
import type { Trigger, TriggerExecution } from '../types.js';
import type { UpdateTriggerInput } from '../triggers-repository.js';

/**
 * The on-disk DynamoDB row: a {@link Trigger} plus the single-table keys and
 * GSI projection keys. Never returned to callers — {@link toItem}/{@link fromItem}
 * are the only bridge between this and {@link Trigger}.
 */
export interface TriggerItem extends Trigger {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
}

/**
 * The domain {@link Trigger} fields — the allowlist {@link fromItem} projects
 * onto. Using a positive allowlist (rather than a denylist of storage keys)
 * means a newly-added index key on {@link TriggerItem} can never leak into the
 * domain object: anything not named here is simply not copied. The `keyof`
 * type makes a typo or a removed field a compile error.
 */
const TRIGGER_FIELDS: readonly (keyof Trigger)[] = [
  'id',
  'userId',
  'name',
  'description',
  'type',
  'enabled',
  'agentId',
  'prompt',
  'sessionId',
  'modelId',
  'workingDirectory',
  'enabledTools',
  'scheduleConfig',
  'eventConfig',
  'createdAt',
  'updatedAt',
  'lastExecutedAt',
];

/** The domain {@link TriggerExecution} fields — the allowlist {@link fromExecutionItem} projects onto. */
const EXECUTION_FIELDS: readonly (keyof TriggerExecution)[] = [
  'triggerId',
  'executionId',
  'executedAt',
  'sessionId',
  'eventPayload',
  'errorMessage',
  'ttl',
];

/** The single source of truth for a trigger's primary key. */
export function triggerKey(userId: UserId, triggerId: TriggerId): { PK: string; SK: string } {
  return {
    PK: `TRIGGER#${userId}`,
    SK: `TRIGGER#${triggerId}`,
  };
}

/** Project the GSI keys for a trigger from its (type, eventConfig). */
function indexKeys(trigger: Trigger): Pick<TriggerItem, 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK'> {
  const keys: Pick<TriggerItem, 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK'> = {
    GSI1PK: `TYPE#${trigger.type}`,
    GSI1SK: `USER#${trigger.userId}#${trigger.id}`,
  };
  if (trigger.type === 'event' && trigger.eventConfig?.eventSourceId) {
    keys.GSI2PK = `EVENTSOURCE#${trigger.eventConfig.eventSourceId}`;
    keys.GSI2SK = `USER#${trigger.userId}#TRIGGER#${trigger.id}`;
  }
  return keys;
}

/** Domain trigger → storage row. The only place that adds PK/SK/GSI keys. */
export function toItem(trigger: Trigger): TriggerItem {
  return {
    ...trigger,
    ...triggerKey(trigger.userId, trigger.id),
    ...indexKeys(trigger),
  };
}

/**
 * Storage row → domain trigger. Projects onto the {@link Trigger} allowlist, so
 * the single-table keys (PK/SK) and every GSI key are dropped by construction —
 * the only way a field reaches the domain object is by being named in
 * {@link TRIGGER_FIELDS}.
 */
export function fromItem(item: Record<string, unknown>): Trigger {
  return pick(item as unknown as Trigger, TRIGGER_FIELDS);
}

/**
 * Storage row → domain execution. Same allowlist projection as {@link fromItem}
 * (drops PK/SK), with one back-compat fixup: very old execution rows stored the
 * timestamp under `startedAt` instead of `executedAt`, so fall back to it when
 * `executedAt` is absent. This is the single place that knows about the legacy
 * attribute — callers always see a populated `executedAt`.
 */
export function fromExecutionItem(item: Record<string, unknown>): TriggerExecution {
  const execution = pick(item as unknown as TriggerExecution, EXECUTION_FIELDS);
  if (!execution.executedAt) {
    execution.executedAt = (item.startedAt as string) ?? '';
  }
  return execution;
}

/**
 * Build the dynamic UpdateExpression for a partial trigger update. Pure
 * (no I/O): turns an {@link UpdateTriggerInput} patch into the SET/REMOVE
 * expression plus its attribute name/value maps, always stamping `updatedAt`
 * and keeping the GSI1/GSI2 index keys consistent with the resulting item.
 *
 * The trickiest part — GSI2 must be REMOVEd, not just left stale, whenever the
 * trigger stops being an event subscription — is concentrated here so it can
 * be reasoned about and tested on its own.
 */
export function buildUpdateExpression(
  userId: UserId,
  triggerId: TriggerId,
  updates: UpdateTriggerInput,
  existingTrigger: Trigger,
  now: string
): {
  updateExpression: string;
  attributeNames: Record<string, string>;
  attributeValues: Record<string, unknown>;
} {
  const updateParts: string[] = ['updatedAt = :updatedAt'];
  const removeParts: string[] = [];
  const attributeValues: Record<string, unknown> = { ':updatedAt': now };
  const attributeNames: Record<string, string> = {};

  if (updates.name !== undefined) {
    updateParts.push('#name = :name');
    attributeNames['#name'] = 'name';
    attributeValues[':name'] = updates.name;
  }
  if (updates.description !== undefined) {
    updateParts.push('description = :description');
    attributeValues[':description'] = updates.description;
  }
  if (updates.type !== undefined) {
    updateParts.push('#type = :type');
    attributeNames['#type'] = 'type';
    attributeValues[':type'] = updates.type;

    // Update GSI1 keys when type changes
    updateParts.push('GSI1PK = :gsi1pk');
    attributeValues[':gsi1pk'] = `TYPE#${updates.type}`;
  }
  if (updates.agentId !== undefined) {
    updateParts.push('agentId = :agentId');
    attributeValues[':agentId'] = updates.agentId;
  }
  if (updates.prompt !== undefined) {
    updateParts.push('prompt = :prompt');
    attributeValues[':prompt'] = updates.prompt;
  }
  if (updates.sessionId !== undefined) {
    updateParts.push('sessionId = :sessionId');
    attributeValues[':sessionId'] = updates.sessionId;
  }
  if (updates.modelId !== undefined) {
    updateParts.push('modelId = :modelId');
    attributeValues[':modelId'] = updates.modelId;
  }
  if (updates.workingDirectory !== undefined) {
    updateParts.push('workingDirectory = :workingDirectory');
    attributeValues[':workingDirectory'] = updates.workingDirectory;
  }
  if (updates.enabledTools !== undefined) {
    updateParts.push('enabledTools = :enabledTools');
    attributeValues[':enabledTools'] = updates.enabledTools;
  }
  if (updates.enabled !== undefined) {
    updateParts.push('#enabled = :enabled');
    attributeNames['#enabled'] = 'enabled';
    attributeValues[':enabled'] = updates.enabled;
  }
  if (updates.scheduleConfig !== undefined) {
    updateParts.push('scheduleConfig = :scheduleConfig');
    attributeValues[':scheduleConfig'] = updates.scheduleConfig;
  }
  if (updates.eventConfig !== undefined) {
    updateParts.push('eventConfig = :eventConfig');
    attributeValues[':eventConfig'] = updates.eventConfig;
  }

  // Handle GSI2 keys for type changes
  const newType = updates.type || existingTrigger.type;
  const newEventConfig = updates.eventConfig || existingTrigger.eventConfig;

  if (newType === 'event' && newEventConfig?.eventSourceId) {
    // Set GSI2 keys for an event trigger that subscribes to a source.
    updateParts.push('GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
    attributeValues[':gsi2pk'] = `EVENTSOURCE#${newEventConfig.eventSourceId}`;
    attributeValues[':gsi2sk'] = `USER#${userId}#TRIGGER#${triggerId}`;
  } else {
    // Every other case must clear GSI2 so the index stays consistent with the
    // item. This covers schedule triggers AND event triggers whose updated
    // eventConfig no longer carries an eventSourceId — otherwise the previous
    // EVENTSOURCE# key would be orphaned and the trigger would keep firing
    // for a source it no longer subscribes to. REMOVE is a no-op when the
    // keys are already absent, so this is safe for triggers that never had
    // GSI2 set.
    removeParts.push('GSI2PK', 'GSI2SK');
  }

  let updateExpression = `SET ${updateParts.join(', ')}`;
  if (removeParts.length > 0) {
    updateExpression += ` REMOVE ${removeParts.join(', ')}`;
  }

  return { updateExpression, attributeNames, attributeValues };
}
