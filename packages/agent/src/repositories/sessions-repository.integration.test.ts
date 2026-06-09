/**
 * Repository-layer integration tests for the agent's SessionsRepository, run
 * against a real DynamoDB Local instance (started by the DDB jest config).
 *
 * These exercise behaviours the production SessionsService could never unit-
 * test, because there it is welded to Cognito Identity Pool credentials and
 * AsyncLocalStorage identity resolution. The repository is config/Cognito-free:
 * the client and the already-resolved partition key (identityId) are injected,
 * so the DynamoDB semantics can be verified directly:
 *   - createSession ConditionExpression (duplicate → skip, returns existing)
 *   - updateSession* existence guard (missing item → no-op, no throw)
 *   - the dynamic UpdateExpression in updateSessionAgentAndStorage
 *   - item shape (channelUserId, removeUndefinedValues), getSession, exists
 *
 * Out of scope here (only verifiable against real AWS): the IAM
 * `dynamodb:LeadingKeys` per-user isolation and the actual identityId
 * resolution — both live in the composition layer, not the repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { type DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SessionsRepository } from './sessions-repository.js';
import { makeLocalClient } from '../tests/integration/client.js';
import { createSessionsTable, deleteTable, uniqueTableName } from '../tests/integration/tables.js';

// The repository is constructed with an already-resolved partition key
// (in production this is the Cognito Identity Pool identityId).
const PK = 'us-east-1:00000000-aaaa-aaaa-aaaa-000000000001';

let client: DynamoDBClient;
let tableName: string;
let repo: SessionsRepository;

beforeAll(async () => {
  client = makeLocalClient();
  tableName = uniqueTableName('agent-sessions');
  await createSessionsTable(client, tableName);
});

afterAll(async () => {
  await deleteTable(client, tableName);
  client.destroy();
});

beforeEach(() => {
  repo = new SessionsRepository(client, tableName, PK);
});

/** Read the raw stored item directly (bypassing the repository). */
async function rawGet(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { userId: { S: PK }, sessionId: { S: sessionId } },
    })
  );
  return result.Item ? unmarshall(result.Item) : undefined;
}

describe('SessionsRepository (DynamoDB Local)', () => {
  it('creates a session and stores it under the injected partition key', async () => {
    const created = await repo.createSession({
      sessionId: 's-create',
      title: 'first',
      agentId: 'agent-1',
      sessionType: 'user',
      channelUserId: 'pool-sub-123',
    });

    expect(created.userId).toBe(PK);
    expect(created.sessionId).toBe('s-create');

    const stored = await rawGet('s-create');
    expect(stored).toMatchObject({
      userId: PK,
      sessionId: 's-create',
      title: 'first',
      agentId: 'agent-1',
      sessionType: 'user',
      channelUserId: 'pool-sub-123',
    });
    // removeUndefinedValues: storagePath was never provided, so it is absent.
    expect(stored).not.toHaveProperty('storagePath');
  });

  it('createSession is idempotent: a duplicate sessionId does not overwrite', async () => {
    await repo.createSession({ sessionId: 's-dup', title: 'original' });
    // Second create with the same key must be skipped (ConditionExpression),
    // not throw, and must not clobber the stored title.
    await expect(
      repo.createSession({ sessionId: 's-dup', title: 'SHOULD-NOT-WIN' })
    ).resolves.toBeDefined();

    const stored = await rawGet('s-dup');
    expect(stored?.title).toBe('original');
  });

  it('getSession returns the item, or null when absent', async () => {
    await repo.createSession({ sessionId: 's-get', title: 't' });
    const got = await repo.getSession('s-get');
    expect(got?.title).toBe('t');

    expect(await repo.getSession('s-missing')).toBeNull();
  });

  it('sessionExists reflects presence', async () => {
    await repo.createSession({ sessionId: 's-exists', title: 't' });
    expect(await repo.sessionExists('s-exists')).toBe(true);
    expect(await repo.sessionExists('s-nope')).toBe(false);
  });

  it('updateSessionTitle updates title + updatedAt on an existing session', async () => {
    const created = await repo.createSession({ sessionId: 's-title', title: 'old' });
    await repo.updateSessionTitle('s-title', 'new');

    const stored = await rawGet('s-title');
    expect(stored?.title).toBe('new');
    expect(String(stored?.updatedAt) >= created.updatedAt).toBe(true);
  });

  it('updateSessionTimestamp bumps updatedAt on an existing session', async () => {
    const created = await repo.createSession({ sessionId: 's-ts', title: 't' });
    await repo.updateSessionTimestamp('s-ts');
    const stored = await rawGet('s-ts');
    expect(String(stored?.updatedAt) >= created.updatedAt).toBe(true);
  });

  it('update on a missing session is a no-op (existence condition), does not throw', async () => {
    await expect(repo.updateSessionTitle('ghost', 'x')).resolves.toBeUndefined();
    await expect(repo.updateSessionTimestamp('ghost')).resolves.toBeUndefined();
    await expect(repo.updateSessionAgentAndStorage('ghost', 'a', 'p')).resolves.toBeUndefined();
    // Nothing was created by the failed updates.
    expect(await rawGet('ghost')).toBeUndefined();
  });

  it('updateSessionAgentAndStorage builds the dynamic expression: both fields', async () => {
    await repo.createSession({ sessionId: 's-both', title: 't' });
    await repo.updateSessionAgentAndStorage('s-both', 'agent-X', 'path/X');
    const stored = await rawGet('s-both');
    expect(stored).toMatchObject({ agentId: 'agent-X', storagePath: 'path/X' });
  });

  it('updateSessionAgentAndStorage updates only the provided field (agentId only)', async () => {
    await repo.createSession({
      sessionId: 's-partial',
      title: 't',
      agentId: 'orig',
      storagePath: 'orig/path',
    });
    await repo.updateSessionAgentAndStorage('s-partial', 'changed', undefined);
    const stored = await rawGet('s-partial');
    expect(stored?.agentId).toBe('changed');
    // storagePath was not in the update → must remain its original value.
    expect(stored?.storagePath).toBe('orig/path');
  });
});
