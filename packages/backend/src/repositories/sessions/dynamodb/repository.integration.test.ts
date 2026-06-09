/**
 * Repository-layer integration tests for SessionsRepository, run against a real
 * DynamoDB Local instance (started by the integration globalSetup).
 *
 * These cover behaviours the marshall-stubbed unit tests cannot: the
 * `userId-updatedAt-index` GSI ordering (newest first), Limit + opaque
 * nextToken pagination, point reads (hit/miss), delete, and per-user
 * isolation. Sessions are written directly via PutItem here because the
 * production writer lives in the agent package; the backend repository is
 * read/delete-only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { type DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { AgentId, IdentityId } from '@moca/core';
import { DynamoDBSessionsRepository } from './repository.js';
import { makeLocalClient } from '../../../tests/integration/client.js';
import {
  createSessionsTable,
  deleteTable,
  uniqueTableName,
} from '../../../tests/integration/tables.js';

const USER_A = 'us-east-1:00000000-aaaa-aaaa-aaaa-000000000001' as IdentityId;
const USER_B = 'us-east-1:00000000-bbbb-bbbb-bbbb-000000000002' as IdentityId;
const AGENT = 'agent-1' as AgentId;

let client: DynamoDBClient;
let tableName: string;
let repo: DynamoDBSessionsRepository;

beforeAll(async () => {
  client = makeLocalClient();
  tableName = uniqueTableName('sessions');
  await createSessionsTable(client, tableName);
});

afterAll(async () => {
  await deleteTable(client, tableName);
  client.destroy();
});

beforeEach(() => {
  repo = new DynamoDBSessionsRepository(client, tableName);
});

/** Seed a session row directly (the backend repo never writes). */
async function putSession(opts: {
  userId: IdentityId;
  sessionId: string;
  title: string;
  updatedAt: string;
  agentId?: AgentId;
  sessionType?: 'user' | 'event' | 'subagent';
}): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(
        {
          userId: opts.userId,
          sessionId: opts.sessionId,
          title: opts.title,
          agentId: opts.agentId,
          sessionType: opts.sessionType,
          createdAt: opts.updatedAt,
          updatedAt: opts.updatedAt,
        },
        { removeUndefinedValues: true }
      ),
    })
  );
}

describe('SessionsRepository (DynamoDB Local)', () => {
  it('lists sessions newest-first via the userId-updatedAt-index GSI', async () => {
    await putSession({
      userId: USER_A,
      sessionId: 's-old',
      title: 'old',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await putSession({
      userId: USER_A,
      sessionId: 's-mid',
      title: 'mid',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    await putSession({
      userId: USER_A,
      sessionId: 's-new',
      title: 'new',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });

    const result = await repo.listSessions(USER_A);

    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s-new', 's-mid', 's-old']);
    expect(result.hasMore).toBe(false);
    expect(result.nextToken).toBeUndefined();
  });

  it('paginates with Limit and a round-trippable opaque nextToken', async () => {
    const u = 'us-east-1:page-user' as IdentityId;
    for (let i = 0; i < 5; i++) {
      await putSession({
        userId: u,
        sessionId: `p-${i}`,
        title: `t${i}`,
        // zero-padded so lexical order matches numeric order
        updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }

    const page1 = await repo.listSessions(u, 2);
    expect(page1.sessions).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextToken).toBeTruthy();

    // Decode the opaque token the same way the route does, and resume.
    const startKey = JSON.parse(Buffer.from(page1.nextToken!, 'base64').toString('utf-8'));
    const page2 = await repo.listSessions(u, 2, startKey);
    expect(page2.sessions).toHaveLength(2);

    const seen = [...page1.sessions, ...page2.sessions].map((s) => s.sessionId);
    expect(new Set(seen).size).toBe(4); // no overlap across pages
  });

  it('returns an empty result for a user with no sessions', async () => {
    const result = await repo.listSessions('us-east-1:nobody' as IdentityId);
    expect(result.sessions).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('isolates sessions per user', async () => {
    await putSession({
      userId: USER_B,
      sessionId: 'b-1',
      title: 'b',
      updatedAt: '2026-02-02T00:00:00.000Z',
    });
    const a = await repo.listSessions(USER_A);
    expect(a.sessions.every((s) => s.sessionId !== 'b-1')).toBe(true);
  });

  it('gets a single session and maps its fields', async () => {
    await putSession({
      userId: USER_A,
      sessionId: 's-get',
      title: 'gettable',
      updatedAt: '2026-04-01T00:00:00.000Z',
      agentId: AGENT,
      sessionType: 'user',
    });

    const got = await repo.getSession(USER_A, 's-get');
    expect(got).not.toBeNull();
    expect(got!.title).toBe('gettable');
    expect(got!.agentId).toBe(AGENT);
    expect(got!.sessionType).toBe('user');
  });

  it('returns null for a missing session', async () => {
    expect(await repo.getSession(USER_A, 'does-not-exist')).toBeNull();
  });

  it('deletes a session', async () => {
    await putSession({
      userId: USER_A,
      sessionId: 's-del',
      title: 'del',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    await repo.deleteSession(USER_A, 's-del');
    expect(await repo.getSession(USER_A, 's-del')).toBeNull();
  });
});

// Review-driven checks: same bug class (read paths disagreeing, or pagination
// losing/duplicating rows on a non-unique GSI sort key).
describe('SessionsRepository — read-path consistency (review hardening)', () => {
  let repo: DynamoDBSessionsRepository;
  beforeEach(() => {
    repo = new DynamoDBSessionsRepository(client, tableName);
  });

  // The GSI list (userId-updatedAt-index) and the base-table point read must
  // agree: every sessionId surfaced by listSessions must be fetchable by
  // getSession. A projection/key mismatch would let one path see rows the
  // other can't — the read-side analog of the GSI2 orphan bug.
  it('every session listed via the GSI is fetchable by getSession', async () => {
    const u = 'us-east-1:consistency-user' as IdentityId;
    for (let i = 0; i < 3; i++) {
      await putSession({
        userId: u,
        sessionId: `c-${i}`,
        title: `t${i}`,
        updatedAt: `2026-07-0${i + 1}T00:00:00.000Z`,
        agentId: AGENT,
      });
    }

    const listed = await repo.listSessions(u);
    expect(listed.sessions.length).toBe(3);
    for (const s of listed.sessions) {
      const got = await repo.getSession(u, s.sessionId);
      expect(got).not.toBeNull();
      expect(got!.title).toBe(s.title);
    }
  });

  // updatedAt is the GSI sort key but is NOT unique. Paginating across rows
  // that share an identical updatedAt must not drop or duplicate any session —
  // a classic pagination bug when the sort key has ties.
  it('paginates correctly when several sessions share the same updatedAt', async () => {
    const u = 'us-east-1:tie-user' as IdentityId;
    const sameTs = '2026-08-01T00:00:00.000Z';
    for (let i = 0; i < 4; i++) {
      await putSession({ userId: u, sessionId: `tie-${i}`, title: `t${i}`, updatedAt: sameTs });
    }

    const collected: string[] = [];
    let startKey: Record<string, unknown> | undefined;
    let guard = 0;
    do {
      const page = await repo.listSessions(u, 2, startKey);
      collected.push(...page.sessions.map((s) => s.sessionId));
      startKey = page.nextToken
        ? JSON.parse(Buffer.from(page.nextToken, 'base64').toString('utf-8'))
        : undefined;
      guard++;
    } while (startKey && guard < 10);

    // All four distinct sessions seen exactly once despite identical sort keys.
    expect(new Set(collected).size).toBe(4);
    expect(collected).toHaveLength(4);
  });
});
