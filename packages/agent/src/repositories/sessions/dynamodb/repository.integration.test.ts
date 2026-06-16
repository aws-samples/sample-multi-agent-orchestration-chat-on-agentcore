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
import { type DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { IdentityId, UserId, AgentId } from '@moca/core';
import { DynamoDBSessionsRepository } from './repository.js';
import { makeLocalClient } from '../../../tests/integration/client.js';
import {
  createSessionsTable,
  deleteTable,
  uniqueTableName,
} from '../../../tests/integration/tables.js';

// The repository is constructed with an already-resolved partition key
// (in production this is the Cognito Identity Pool identityId).
const PK = 'us-east-1:00000000-aaaa-aaaa-aaaa-000000000001' as IdentityId;

let client: DynamoDBClient;
let tableName: string;
let repo: DynamoDBSessionsRepository;

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
  repo = new DynamoDBSessionsRepository(client, tableName, PK);
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
      agentId: 'agent-1' as AgentId,
      sessionType: 'user',
      channelUserId: 'pool-sub-123' as UserId,
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
    await expect(
      repo.updateSessionAgentAndStorage('ghost', 'a' as AgentId, 'p')
    ).resolves.toBeUndefined();
    // Nothing was created by the failed updates.
    expect(await rawGet('ghost')).toBeUndefined();
  });

  it('updateSessionAgentAndStorage builds the dynamic expression: both fields', async () => {
    await repo.createSession({ sessionId: 's-both', title: 't' });
    await repo.updateSessionAgentAndStorage('s-both', 'agent-X' as AgentId, 'path/X');
    const stored = await rawGet('s-both');
    expect(stored).toMatchObject({ agentId: 'agent-X', storagePath: 'path/X' });
  });

  it('updateSessionAgentAndStorage updates only the provided field (agentId only)', async () => {
    await repo.createSession({
      sessionId: 's-partial',
      title: 't',
      agentId: 'orig' as AgentId,
      storagePath: 'orig/path',
    });
    await repo.updateSessionAgentAndStorage('s-partial', 'changed' as AgentId, undefined);
    const stored = await rawGet('s-partial');
    expect(stored?.agentId).toBe('changed');
    // storagePath was not in the update → must remain its original value.
    expect(stored?.storagePath).toBe('orig/path');
  });
});

describe('SessionsRepository.listSessions (DynamoDB Local)', () => {
  // A dedicated partition key so this suite's rows are isolated from the
  // create/update suite above (which shares the same table).
  const LIST_PK = 'us-east-1:00000000-aaaa-aaaa-aaaa-000000000099' as IdentityId;
  let listRepo: DynamoDBSessionsRepository;

  beforeAll(async () => {
    listRepo = new DynamoDBSessionsRepository(client, tableName, LIST_PK);
    // Seed five sessions with strictly increasing updatedAt values. The
    // repository sets updatedAt = now on create, so we space them out by
    // writing sequentially with distinct timestamps via updateSessionTimestamp.
    for (let i = 0; i < 5; i++) {
      await listRepo.createSession({ sessionId: `list-${i}`, title: `session ${i}` });
      // Ensure a distinct, monotonically increasing updatedAt per row.
      await new Promise((r) => setTimeout(r, 5));
      await listRepo.updateSessionTimestamp(`list-${i}`);
    }
  });

  it('returns the caller sessions newest-first', async () => {
    const result = await listRepo.listSessions(10);
    expect(result.sessions).toHaveLength(5);
    expect(result.hasMore).toBe(false);
    expect(result.nextToken).toBeUndefined();
    // Newest first: list-4 was written last, so it must come first.
    expect(result.sessions[0].sessionId).toBe('list-4');
    expect(result.sessions[4].sessionId).toBe('list-0');
    // Only summary fields are projected (no userId / channelUserId leak).
    expect(result.sessions[0]).not.toHaveProperty('userId');
    expect(result.sessions[0]).not.toHaveProperty('channelUserId');
  });

  it('paginates with an opaque nextToken', async () => {
    const page1 = await listRepo.listSessions(2);
    expect(page1.sessions).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextToken).toBeDefined();

    const page2 = await listRepo.listSessions(2, page1.nextToken);
    expect(page2.sessions).toHaveLength(2);
    // Pages must not overlap.
    const ids1 = page1.sessions.map((s) => s.sessionId);
    const ids2 = page2.sessions.map((s) => s.sessionId);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it('returns an empty page for a user with no sessions', async () => {
    const emptyRepo = new DynamoDBSessionsRepository(
      client,
      tableName,
      'us-east-1:00000000-aaaa-aaaa-aaaa-0000000000ee' as IdentityId
    );
    const result = await emptyRepo.listSessions(10);
    expect(result.sessions).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('throws on a malformed pagination token', async () => {
    await expect(listRepo.listSessions(2, 'not-base64-json!!')).rejects.toThrow(
      'Invalid pagination token'
    );
  });
});

// Review-driven probes against real DynamoDB Local, mirroring the backend's
// hardening suite. These target properties the existing happy-path cases above
// do not assert: cross-user isolation, the DynamoDB "Limit == count" hasMore
// gotcha, and a full pagination walk with a non-unique sort key.
describe('SessionsRepository.listSessions — review hardening (DynamoDB Local)', () => {
  it('isolates sessions per user: never returns another user\'s rows', async () => {
    const userA = new DynamoDBSessionsRepository(
      client,
      tableName,
      'us-east-1:00000000-aaaa-aaaa-aaaa-0000000000a1' as IdentityId
    );
    const userB = new DynamoDBSessionsRepository(
      client,
      tableName,
      'us-east-1:00000000-aaaa-aaaa-aaaa-0000000000b2' as IdentityId
    );
    await userA.createSession({ sessionId: 'a-only', title: 'A session' });
    await userB.createSession({ sessionId: 'b-only', title: 'B session' });

    const aResult = await userA.listSessions(50);
    expect(aResult.sessions.map((s) => s.sessionId)).toEqual(['a-only']);
    expect(aResult.sessions.every((s) => s.sessionId !== 'b-only')).toBe(true);
  });

  // DynamoDB returns a LastEvaluatedKey whenever a Query stops because it hit
  // `Limit`, EVEN IF no further items exist. So listing N items with a page
  // size of exactly N must NOT advertise a further page — otherwise the tool
  // tells the model "More sessions are available" and the model burns a call
  // fetching an empty page.
  it('does not report hasMore when the page size exactly equals the row count', async () => {
    const repo = new DynamoDBSessionsRepository(
      client,
      tableName,
      'us-east-1:00000000-aaaa-aaaa-aaaa-0000000000c3' as IdentityId
    );
    for (let i = 0; i < 3; i++) {
      await repo.createSession({ sessionId: `exact-${i}`, title: `t${i}` });
      await new Promise((r) => setTimeout(r, 5));
      await repo.updateSessionTimestamp(`exact-${i}`);
    }

    const result = await repo.listSessions(3); // page size == total
    expect(result.sessions).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextToken).toBeUndefined();
  });

  // A full walk via nextToken must terminate and surface every session exactly
  // once, with no drops or duplicates — including the final (possibly empty)
  // page produced by the Limit==count gotcha above.
  it('walks every page to completion with no drops or duplicates', async () => {
    const repo = new DynamoDBSessionsRepository(
      client,
      tableName,
      'us-east-1:00000000-aaaa-aaaa-aaaa-0000000000d4' as IdentityId
    );
    const SEEDED = 7;
    for (let i = 0; i < SEEDED; i++) {
      await repo.createSession({ sessionId: `walk-${i}`, title: `t${i}` });
      await new Promise((r) => setTimeout(r, 5));
      await repo.updateSessionTimestamp(`walk-${i}`);
    }

    const collected: string[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const page = await repo.listSessions(2, token);
      collected.push(...page.sessions.map((s) => s.sessionId));
      token = page.nextToken;
      guard++;
    } while (token && guard < 20);

    expect(guard).toBeLessThan(20); // terminated, no token loop
    expect(new Set(collected).size).toBe(SEEDED);
    expect(collected).toHaveLength(SEEDED);
  });

  // `updatedAt` is the GSI sort key but is NOT unique. The resume key must
  // therefore carry the base-table key (sessionId) too, or a page boundary
  // landing between rows that share an updatedAt would drop or duplicate rows.
  it('paginates correctly when several sessions share the same updatedAt', async () => {
    const TIE_PK = 'us-east-1:00000000-aaaa-aaaa-aaaa-0000000000e5' as IdentityId;
    const repo = new DynamoDBSessionsRepository(client, tableName, TIE_PK);
    // Force a genuine collision: write rows directly with an identical
    // updatedAt (the public createSession stamps now() at ms resolution, which
    // would not reliably tie). The base table projects ALL to the GSI.
    const TIE = 4;
    const sameTs = '2026-08-01T00:00:00.000Z';
    for (let i = 0; i < TIE; i++) {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall({
            userId: TIE_PK,
            sessionId: `tie-${i}`,
            title: `t${i}`,
            createdAt: sameTs,
            updatedAt: sameTs,
          }),
        })
      );
    }

    const collected: string[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const page = await repo.listSessions(2, token);
      collected.push(...page.sessions.map((s) => s.sessionId));
      token = page.nextToken;
      guard++;
    } while (token && guard < 20);

    expect(new Set(collected).size).toBe(TIE);
    expect(collected).toHaveLength(TIE);
  });
});
