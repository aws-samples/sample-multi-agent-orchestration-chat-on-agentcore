/**
 * Repository-layer integration tests for AgentsRepository, run against a real
 * DynamoDB Local instance (started by the integration globalSetup).
 *
 * These exercise what the mapper unit tests cannot: real key matching, the
 * isShared (string) GSI projection + newest-first ordering, the dynamic
 * UpdateExpression (including the defaultStoragePath REMOVE), and the
 * attribute_exists ConditionExpression that turns a missing-agent update into
 * AgentNotFoundError.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AgentId, UserId } from '@moca/core';
import { AgentNotFoundError, type Agent } from '../../../types/index.js';
import { DynamoDBAgentsRepository } from './repository.js';
import { makeLocalClient } from '../../../tests/integration/client.js';
import { createAgentsTable, deleteTable, uniqueTableName } from '../../../tests/integration/tables.js';

const USER_A = 'user-aaaa' as UserId;
const USER_B = 'user-bbbb' as UserId;

let client: DynamoDBClient;
let tableName: string;
let repo: DynamoDBAgentsRepository;

beforeAll(async () => {
  client = makeLocalClient();
  tableName = uniqueTableName('agents');
  await createAgentsTable(client, tableName);
});

afterAll(async () => {
  await deleteTable(client, tableName);
  client.destroy();
});

beforeEach(() => {
  repo = new DynamoDBAgentsRepository(client, tableName);
});

let seq = 0;
function makeAgent(userId: UserId, overrides: Partial<Agent> = {}): Agent {
  seq += 1;
  const createdAt = `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`;
  return {
    userId,
    agentId: `agent-${seq}-${Math.floor(seq * 7919) % 9973}` as AgentId,
    name: `Agent ${seq}`,
    description: 'd',
    systemPrompt: 's',
    enabledTools: [],
    scenarios: [],
    createdAt,
    updatedAt: createdAt,
    isShared: false,
    createdBy: userId,
    ...overrides,
  };
}

/**
 * Drain every page of listShared into a flat id list. The table is shared
 * across tests (only the repo is recreated in beforeEach), so shared agents
 * accumulate; assertions must use containment, and "is it absent?" checks must
 * see ALL pages — not just the first.
 */
async function listAllSharedIds(r: DynamoDBAgentsRepository): Promise<AgentId[]> {
  const ids: AgentId[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await r.listShared(100, startKey);
    ids.push(...page.agents.map((a) => a.agentId));
    startKey = page.lastEvaluatedKey;
  } while (startKey);
  return ids;
}

describe('DynamoDBAgentsRepository', () => {
  it('round-trips an agent through put/get with isShared as a boolean', async () => {
    const agent = makeAgent(USER_A, { isShared: true, defaultStoragePath: '/work' });
    await repo.put(agent);

    const got = await repo.get(USER_A, agent.agentId);
    expect(got).not.toBeNull();
    expect(got!.isShared).toBe(true); // stored as 'true', read back as boolean
    expect(got!.defaultStoragePath).toBe('/work');
  });

  it('returns null for a missing agent', async () => {
    expect(await repo.get(USER_A, 'nope' as AgentId)).toBeNull();
  });

  it('get is scoped by userId — another user cannot read your agent', async () => {
    // The primary key is composite (userId HASH + agentId RANGE). A get with a
    // foreign userId but a real agentId must miss, not leak across tenants.
    const agent = makeAgent(USER_A);
    await repo.put(agent);

    expect(await repo.get(USER_A, agent.agentId)).not.toBeNull();
    expect(await repo.get(USER_B, agent.agentId)).toBeNull();
  });

  it('delete is scoped by userId — it cannot remove another user’s agent', async () => {
    // A delete keyed on the wrong userId must be a no-op against the owner's row,
    // not a cross-tenant deletion.
    const agent = makeAgent(USER_A);
    await repo.put(agent);

    await repo.delete(USER_B, agent.agentId);

    expect(await repo.get(USER_A, agent.agentId)).not.toBeNull();
  });

  it('lists only the requesting user’s agents', async () => {
    const a1 = makeAgent(USER_A);
    const a2 = makeAgent(USER_A);
    const b1 = makeAgent(USER_B);
    await Promise.all([repo.put(a1), repo.put(a2), repo.put(b1)]);

    const aAgents = await repo.listByUser(USER_A);
    const ids = aAgents.map((a) => a.agentId);
    expect(ids).toEqual(expect.arrayContaining([a1.agentId, a2.agentId]));
    expect(ids).not.toContain(b1.agentId);
  });

  it('toggleShare flips the flag and the agent then appears in listShared', async () => {
    const agent = makeAgent(USER_A, { isShared: false });
    await repo.put(agent);

    const toggled = await repo.toggleShare(USER_A, agent.agentId);
    expect(toggled.isShared).toBe(true);

    const { agents } = await repo.listShared(50);
    expect(agents.map((a) => a.agentId)).toContain(agent.agentId);
  });

  it('toggleShare from shared→unshared removes the agent from listShared', async () => {
    // The reverse of the flip-on case: toggling off must re-key the GSI entry to
    // 'false' so the agent disappears from the shared listing.
    const agent = makeAgent(USER_A, { isShared: true });
    await repo.put(agent);
    expect(await listAllSharedIds(repo)).toContain(agent.agentId);

    const toggled = await repo.toggleShare(USER_A, agent.agentId);
    expect(toggled.isShared).toBe(false);

    expect(await listAllSharedIds(repo)).not.toContain(agent.agentId);
  });

  it('listShared excludes non-shared agents', async () => {
    // isShared is stored as the GSI hash key 'true'/'false'. A private agent
    // must never surface in the shared query, regardless of pagination.
    const privateAgent = makeAgent(USER_A, { isShared: false });
    await repo.put(privateAgent);

    expect(await listAllSharedIds(repo)).not.toContain(privateAgent.agentId);
  });

  it('toggleShare throws AgentNotFoundError for a missing agent', async () => {
    await expect(repo.toggleShare(USER_A, 'ghost' as AgentId)).rejects.toBeInstanceOf(
      AgentNotFoundError
    );
  });

  it('toggleShare rejects (and does not resurrect the row) when deleted in the get→update race', async () => {
    // The get→update TOCTOU window: the initial read sees the agent, but the
    // row is deleted before the UpdateItem lands. Without a ConditionExpression
    // the UpdateItem would upsert a partial row back into existence. We force
    // the interleave by stubbing get() to return a stale agent for a row that
    // was never persisted, then assert the conditional write fails closed.
    const ghost = makeAgent(USER_A, { isShared: false });
    const getSpy = jest.spyOn(repo, 'get').mockResolvedValueOnce(ghost);

    await expect(repo.toggleShare(USER_A, ghost.agentId)).rejects.toBeInstanceOf(
      AgentNotFoundError
    );
    getSpy.mockRestore();

    // The condition must have prevented any partial-row resurrection.
    expect(await repo.get(USER_A, ghost.agentId)).toBeNull();
  });

  it('update applies a partial patch and always refreshes updatedAt', async () => {
    const agent = makeAgent(USER_A, { name: 'before' });
    await repo.put(agent);

    const updated = await repo.update(USER_A, agent.agentId, { name: 'after' });
    expect(updated.name).toBe('after');
    expect(updated.updatedAt).not.toBe(agent.updatedAt);
  });

  it('update leaves unpatched fields intact (no full-item overwrite)', async () => {
    // A partial update must SET only the named fields. If the expression ever
    // regressed into a full PutItem-style overwrite, the untouched fields below
    // would be dropped — this guards that.
    const agent = makeAgent(USER_A, {
      name: 'before',
      description: 'keep-me',
      systemPrompt: 'keep-prompt',
      enabledTools: ['t1', 't2'],
      defaultStoragePath: '/work',
    });
    await repo.put(agent);

    const updated = await repo.update(USER_A, agent.agentId, { name: 'after' });

    expect(updated.name).toBe('after');
    expect(updated.description).toBe('keep-me');
    expect(updated.systemPrompt).toBe('keep-prompt');
    expect(updated.enabledTools).toEqual(['t1', 't2']);
    expect(updated.defaultStoragePath).toBe('/work');
    expect(updated.createdAt).toBe(agent.createdAt); // never rewritten
  });

  it('update on a shared agent keeps it shared and still in listShared', async () => {
    // updatedAt is SET on every update; isShared must NOT be collaterally
    // touched, or the agent would silently drop out of the shared GSI.
    const agent = makeAgent(USER_A, { isShared: true, name: 'before' });
    await repo.put(agent);

    const updated = await repo.update(USER_A, agent.agentId, { name: 'after' });
    expect(updated.isShared).toBe(true);

    expect(await listAllSharedIds(repo)).toContain(agent.agentId);
  });

  it('update with defaultStoragePath="" REMOVEs the attribute', async () => {
    const agent = makeAgent(USER_A, { defaultStoragePath: '/work' });
    await repo.put(agent);

    const updated = await repo.update(USER_A, agent.agentId, { defaultStoragePath: '' });
    expect(updated.defaultStoragePath).toBeUndefined();
  });

  it('update throws AgentNotFoundError when the agent does not exist', async () => {
    await expect(
      repo.update(USER_A, 'missing' as AgentId, { name: 'x' })
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it('delete is idempotent and removes the row', async () => {
    const agent = makeAgent(USER_A);
    await repo.put(agent);

    await repo.delete(USER_A, agent.agentId);
    expect(await repo.get(USER_A, agent.agentId)).toBeNull();
    // Deleting again must not throw.
    await expect(repo.delete(USER_A, agent.agentId)).resolves.toBeUndefined();
  });

  it('listShared returns shared agents newest-first and paginates by key', async () => {
    const older = makeAgent(USER_A, { isShared: true });
    const newer = makeAgent(USER_B, { isShared: true });
    await repo.put(older);
    await repo.put(newer);

    const firstPage = await repo.listShared(1);
    expect(firstPage.agents).toHaveLength(1);
    // GSI sort is createdAt descending → the newer agent comes first.
    expect(firstPage.agents[0].createdAt >= older.createdAt).toBe(true);
    expect(firstPage.lastEvaluatedKey).toBeDefined();

    const secondPage = await repo.listShared(1, firstPage.lastEvaluatedKey);
    expect(secondPage.agents[0].agentId).not.toBe(firstPage.agents[0].agentId);
  });
});
