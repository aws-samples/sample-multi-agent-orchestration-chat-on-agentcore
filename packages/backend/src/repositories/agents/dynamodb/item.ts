/**
 * DynamoDB storage mapping for agents — IMPLEMENTATION DETAIL.
 *
 * Everything that knows the agents table layout lives here: the primary key,
 * the `isShared` boolean<->string conversion required by the
 * `isShared-createdAt-index` GSI (DynamoDB cannot key on a boolean), and the
 * dynamic partial-update expression. Callers of the repository never import
 * this module; it exists so the rest of the codebase stays in terms of the
 * domain {@link Agent}.
 */

import { marshall, unmarshall, type NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { UserId, AgentId } from '@moca/core';
import type { Agent, DynamoAgent } from '../../../types/agent-types.js';
import type { UpdateAgentPatch } from '../agents-repository.js';

/** Domain agent -> storage row (isShared boolean -> 'true'/'false' for the GSI). */
export function toDynamoAgent(agent: Agent): DynamoAgent {
  return { ...agent, isShared: agent.isShared ? 'true' : 'false' };
}

/** Storage row -> domain agent (isShared 'true'/'false' -> boolean). */
export function fromDynamoAgent(dynamoAgent: DynamoAgent): Agent {
  return { ...dynamoAgent, isShared: dynamoAgent.isShared === 'true' };
}

/** The single source of truth for an agent's primary key. */
export function agentKey(userId: UserId, agentId: AgentId): { userId: UserId; agentId: AgentId } {
  return { userId, agentId };
}

/** Marshalled primary key, ready for a Get/Update/Delete `Key`. */
export function agentKeyAttr(userId: UserId, agentId: AgentId): Record<string, AttributeValue> {
  return marshall(agentKey(userId, agentId));
}

/** Marshal a domain agent into its storage item (dropping undefined attributes). */
export function toItemAttr(agent: Agent): Record<string, AttributeValue> {
  return marshall(toDynamoAgent(agent), { removeUndefinedValues: true });
}

/** Unmarshal a stored row into a domain {@link Agent}. */
export function fromItemAttr(item: Record<string, AttributeValue>): Agent {
  return fromDynamoAgent(unmarshall(item) as DynamoAgent);
}

/**
 * Build the dynamic UpdateExpression for a partial agent update. Pure (no I/O,
 * no SSM, no id generation): the service resolves SSM env and stamps scenario
 * ids before calling, so this only translates a ready-to-store patch into the
 * SET/REMOVE expression plus its name/value maps, always stamping `updatedAt`.
 *
 * `defaultStoragePath: ''` is the documented "clear it" signal and maps to a
 * REMOVE; any other defined value is a SET.
 */
export function buildAgentUpdateExpression(
  patch: UpdateAgentPatch,
  now: string
): {
  updateExpression: string;
  attributeNames: Record<string, string>;
  attributeValues: Record<string, NativeAttributeValue>;
} {
  const setParts: string[] = [];
  const removeParts: string[] = [];
  const attributeNames: Record<string, string> = {};
  const attributeValues: Record<string, NativeAttributeValue> = {};

  const set = (field: string, value: NativeAttributeValue): void => {
    setParts.push(`#${field} = :${field}`);
    attributeNames[`#${field}`] = field;
    attributeValues[`:${field}`] = value;
  };

  if (patch.name !== undefined) set('name', patch.name);
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.icon !== undefined) set('icon', patch.icon);
  if (patch.systemPrompt !== undefined) set('systemPrompt', patch.systemPrompt);
  if (patch.enabledTools !== undefined) set('enabledTools', patch.enabledTools);
  if (patch.scenarios !== undefined) set('scenarios', patch.scenarios);
  if (patch.mcpConfig !== undefined) set('mcpConfig', patch.mcpConfig);

  if (patch.defaultStoragePath !== undefined) {
    if (patch.defaultStoragePath === '') {
      removeParts.push('#defaultStoragePath');
      attributeNames['#defaultStoragePath'] = 'defaultStoragePath';
    } else {
      set('defaultStoragePath', patch.defaultStoragePath);
    }
  }

  // updatedAt is always refreshed.
  set('updatedAt', now);

  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length > 0) {
    updateExpression += ` REMOVE ${removeParts.join(', ')}`;
  }

  return { updateExpression, attributeNames, attributeValues };
}
