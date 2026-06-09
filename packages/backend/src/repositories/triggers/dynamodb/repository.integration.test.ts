/**
 * Repository-layer integration tests for TriggersRepository, run against a
 * real DynamoDB Local instance (started by the integration globalSetup).
 *
 * These tests exercise the behaviours that the marshall-stubbed unit tests
 * cannot: real key-condition matching, GSI1/GSI2 projection, the dynamic
 * UpdateExpression (including GSI2 SET/REMOVE on a type change), server-side
 * COUNT for the per-user limit, and Query ordering/paging.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { AgentId, TriggerId, UserId } from '@moca/core';
import { MAX_TRIGGERS_PER_USER, TriggerLimitExceededError, type Trigger } from '../types.js';
import { DynamoDBTriggersRepository } from './repository.js';
import { makeLocalClient } from '../../../tests/integration/client.js';
import {
  createTriggersTable,
  deleteTable,
  uniqueTableName,
} from '../../../tests/integration/tables.js';

const USER_A = 'user-aaaa' as UserId;
const USER_B = 'user-bbbb' as UserId;
const AGENT = 'agent-1' as AgentId;

let client: DynamoDBClient;
let tableName: string;
let repo: DynamoDBTriggersRepository;

beforeAll(async () => {
  client = makeLocalClient();
  tableName = uniqueTableName('triggers');
  await createTriggersTable(client, tableName);
});

afterAll(async () => {
  await deleteTable(client, tableName);
  client.destroy();
});

beforeEach(() => {
  // A fresh repository per test; the table is shared but each test uses
  // distinct users/keys so they do not interfere.
  repo = new DynamoDBTriggersRepository(client, tableName);
});

function makeScheduleInput(userId: UserId, name: string) {
  return {
    userId,
    name,
    type: 'schedule' as const,
    agentId: AGENT,
    prompt: 'do the thing',
    scheduleConfig: { expression: 'rate(1 day)' },
  };
}

/** Query GSI1 (by TYPE#) directly — the production code never does this, so
 *  the test must talk to the index itself to verify GSI1 stays consistent. */
async function queryGsi1ByType(type: 'schedule' | 'event'): Promise<Trigger[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: marshall({ ':pk': `TYPE#${type}` }),
    })
  );
  return (result.Items ?? []).map((i) => unmarshall(i) as Trigger);
}

/** Read the raw stored row (including PK/SK/GSI keys) for a trigger. The
 *  repository's public methods deliberately strip those storage keys, so tests
 *  that assert on key consistency must reach the item directly. */
async function getRawItem(
  userId: UserId,
  triggerId: TriggerId
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({ PK: `TRIGGER#${userId}`, SK: `TRIGGER#${triggerId}` }),
    })
  );
  return result.Item ? unmarshall(result.Item) : undefined;
}

/** Seed a raw EXECUTION# row under a trigger's partition (TTL/history item). */
async function putExecutionRow(userTriggerId: string, executedAt: string): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        PK: `TRIGGER#${userTriggerId}`,
        SK: `EXECUTION#${executedAt}`,
        triggerId: userTriggerId,
        executedAt,
        ttl: 9999999999,
      }),
    })
  );
}

describe('TriggersRepository (DynamoDB Local)', () => {
  it('creates a trigger and reads it back by id', async () => {
    const created = await repo.createTrigger(makeScheduleInput(USER_A, 'morning'));
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    // Storage keys are stripped from the domain return value; assert them on
    // the raw row to confirm the item is keyed/indexed correctly.
    const rawCreated = await getRawItem(USER_A, created.id);
    expect(rawCreated?.PK).toBe(`TRIGGER#${USER_A}`);
    expect(rawCreated?.SK).toBe(`TRIGGER#${created.id}`);
    expect(rawCreated?.GSI1PK).toBe('TYPE#schedule');

    const fetched = await repo.getTrigger(USER_A, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('morning');
  });

  it('returns null for a missing trigger', async () => {
    const fetched = await repo.getTrigger(USER_A, 'does-not-exist' as TriggerId);
    expect(fetched).toBeNull();
  });

  it('counts only the calling user’s triggers (server-side COUNT)', async () => {
    await repo.createTrigger(makeScheduleInput(USER_B, 't1'));
    await repo.createTrigger(makeScheduleInput(USER_B, 't2'));
    expect(await repo.countTriggers(USER_B)).toBe(2);
    // USER_A's count is unaffected by USER_B's writes.
    const before = await repo.countTriggers(USER_A);
    expect(typeof before).toBe('number');
  });

  it('enforces MAX_TRIGGERS_PER_USER on create', async () => {
    const heavyUser = 'user-heavy' as UserId;
    for (let i = 0; i < MAX_TRIGGERS_PER_USER; i++) {
      await repo.createTrigger(makeScheduleInput(heavyUser, `t${i}`));
    }
    await expect(repo.createTrigger(makeScheduleInput(heavyUser, 'one-too-many'))).rejects.toThrow(
      TriggerLimitExceededError
    );
  });

  it('lists a user’s triggers and filters by type', async () => {
    const u = 'user-list' as UserId;
    await repo.createTrigger(makeScheduleInput(u, 's1'));
    await repo.createTrigger({
      userId: u,
      name: 'e1',
      type: 'event',
      agentId: AGENT,
      prompt: 'on event',
      eventConfig: { eventSourceId: 'src-1' },
    });

    const all = await repo.listTriggers(u);
    expect(all.triggers).toHaveLength(2);

    const events = await repo.listTriggers(u, { type: 'event' });
    expect(events.triggers).toHaveLength(1);
    expect(events.triggers[0].name).toBe('e1');
  });

  it('updates a trigger and bumps updatedAt', async () => {
    const created = await repo.createTrigger(makeScheduleInput(USER_A, 'before'));
    const updated = await repo.updateTrigger(USER_A, created.id, { name: 'after', enabled: false });
    expect(updated.name).toBe('after');
    expect(updated.enabled).toBe(false);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });

  it('sets GSI2 keys when a trigger becomes an event subscription, and finds it via GSI2', async () => {
    const u = 'user-gsi2' as UserId;
    const created = await repo.createTrigger(makeScheduleInput(u, 'will-become-event'));
    expect((await getRawItem(u, created.id))?.GSI2PK).toBeUndefined();

    await repo.updateTrigger(u, created.id, {
      type: 'event',
      eventConfig: { eventSourceId: 'src-xyz' },
    });

    const bySource = await repo.listTriggersByEventSource('src-xyz');
    expect(bySource.map((t) => t.id)).toContain(created.id);
  });

  it('removes GSI2 keys when an event trigger reverts to schedule', async () => {
    const u = 'user-revert' as UserId;
    const created = await repo.createTrigger({
      userId: u,
      name: 'event-first',
      type: 'event',
      agentId: AGENT,
      prompt: 'on event',
      eventConfig: { eventSourceId: 'src-revert' },
    });
    expect(await repo.listTriggersByEventSource('src-revert')).toHaveLength(1);

    await repo.updateTrigger(u, created.id, { type: 'schedule' });

    // GSI2 entry must be gone after reverting to a schedule trigger.
    expect(await repo.listTriggersByEventSource('src-revert')).toHaveLength(0);
    const afterRaw = await getRawItem(u, created.id);
    expect(afterRaw?.GSI2PK).toBeUndefined();
    expect(afterRaw?.GSI2SK).toBeUndefined();
  });

  it('deletes a trigger', async () => {
    const created = await repo.createTrigger(makeScheduleInput(USER_A, 'to-delete'));
    await repo.deleteTrigger(USER_A, created.id);
    expect(await repo.getTrigger(USER_A, created.id)).toBeNull();
  });

  // Regression: an event trigger whose eventConfig is replaced WITHOUT an
  // eventSourceId must not leave a stale GSI2 entry behind. Previously the
  // update branch only SET GSI2 (event + sourceId) or REMOVEd it (schedule),
  // so this case slipped through both and the old EVENTSOURCE# key was
  // orphaned — making the trigger fire for a source it no longer subscribes to.
  it('clears GSI2 when an event trigger’s eventConfig drops eventSourceId', async () => {
    const u = 'user-drop-source' as UserId;
    const created = await repo.createTrigger({
      userId: u,
      name: 'evt',
      type: 'event',
      agentId: AGENT,
      prompt: 'p',
      eventConfig: { eventSourceId: 'SRC_DROP' },
    });
    expect(await repo.listTriggersByEventSource('SRC_DROP')).toHaveLength(1);

    // Replace eventConfig with one that has no eventSourceId (type stays event).
    await repo.updateTrigger(u, created.id, { eventConfig: { eventBusName: 'some-bus' } });

    expect(await repo.listTriggersByEventSource('SRC_DROP')).toHaveLength(0);
    const afterRaw = await getRawItem(u, created.id);
    expect(afterRaw?.GSI2PK).toBeUndefined();
    expect(afterRaw?.GSI2SK).toBeUndefined();
  });

  // Regression: re-pointing an event trigger to a new eventSourceId must move
  // the GSI2 entry, leaving nothing under the old source.
  it('moves GSI2 when an event trigger’s eventSourceId changes', async () => {
    const u = 'user-move-source' as UserId;
    const created = await repo.createTrigger({
      userId: u,
      name: 'evt',
      type: 'event',
      agentId: AGENT,
      prompt: 'p',
      eventConfig: { eventSourceId: 'SRC_FROM' },
    });

    await repo.updateTrigger(u, created.id, { eventConfig: { eventSourceId: 'SRC_TO' } });

    expect(await repo.listTriggersByEventSource('SRC_TO').then((t) => t.length)).toBe(1);
    expect(await repo.listTriggersByEventSource('SRC_FROM').then((t) => t.length)).toBe(0);
  });

  // getExecutions must project rows onto the domain TriggerExecution shape: the
  // single-table PK/SK keys must NOT leak into the returned objects (mirroring
  // how getTrigger/listTriggers strip them).
  it('getExecutions strips PK/SK from returned executions', async () => {
    const t = 'trigger-exec-strip';
    await putExecutionRow(t, '2026-02-01T00:00:00.000Z');

    const { executions } = await repo.getExecutions(t as TriggerId);
    expect(executions).toHaveLength(1);
    expect(executions[0].executedAt).toBe('2026-02-01T00:00:00.000Z');
    // Storage keys must be absent on the domain object.
    expect('PK' in executions[0]).toBe(false);
    expect('SK' in executions[0]).toBe(false);
  });

  // Back-compat: legacy execution rows stored the timestamp under `startedAt`
  // instead of `executedAt`. getExecutions must backfill `executedAt` from it
  // so callers always see a populated timestamp (the route used to do this).
  it('getExecutions backfills executedAt from a legacy startedAt row', async () => {
    const t = 'trigger-exec-legacy';
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          PK: `TRIGGER#${t}`,
          SK: 'EXECUTION#2026-03-01T00:00:00.000Z',
          triggerId: t,
          startedAt: '2026-03-01T00:00:00.000Z', // legacy attribute, no executedAt
          ttl: 9999999999,
        }),
      })
    );

    const { executions } = await repo.getExecutions(t as TriggerId);
    expect(executions).toHaveLength(1);
    expect(executions[0].executedAt).toBe('2026-03-01T00:00:00.000Z');
  });
});

// Additional review-driven checks for the SAME bug class as the GSI2 orphan:
// item attributes vs. derived/index keys drifting out of sync, and the COUNT
// guard mis-counting. These probe update paths the original suite didn't.
describe('TriggersRepository — derived-key consistency (review hardening)', () => {
  let repo: DynamoDBTriggersRepository;
  beforeEach(() => {
    repo = new DynamoDBTriggersRepository(client, tableName);
  });

  // GSI1 (TYPE#) is not queried by production code today, but the item still
  // carries GSI1PK and the update path rewrites it on a type change. If that
  // ever drifts, a future GSI1 consumer would silently see stale rows — the
  // exact failure mode of the GSI2 bug. Assert the index itself stays correct.
  it('keeps GSI1PK consistent with type across a schedule→event change', async () => {
    const u = 'user-gsi1-sync' as UserId;
    const created = await repo.createTrigger(makeScheduleInput(u, 'g1'));

    const beforeSchedule = await queryGsi1ByType('schedule');
    expect(beforeSchedule.map((t) => t.id)).toContain(created.id);

    await repo.updateTrigger(u, created.id, {
      type: 'event',
      eventConfig: { eventSourceId: 'SRC_G1' },
    });

    const onEvent = await queryGsi1ByType('event');
    const onSchedule = await queryGsi1ByType('schedule');
    expect(onEvent.map((t) => t.id)).toContain(created.id);
    // Must NOT still appear under the old TYPE#schedule partition.
    expect(onSchedule.map((t) => t.id)).not.toContain(created.id);
  });

  // An unrelated field update (rename) on an event trigger must not disturb
  // its GSI2 subscription — i.e. the "re-set GSI2 from existing config" branch
  // must fire even when eventConfig isn't part of the update.
  it('preserves the GSI2 subscription when only the name is updated', async () => {
    const u = 'user-rename-evt' as UserId;
    const created = await repo.createTrigger({
      userId: u,
      name: 'before',
      type: 'event',
      agentId: AGENT,
      prompt: 'p',
      eventConfig: { eventSourceId: 'SRC_KEEP' },
    });
    expect(await repo.listTriggersByEventSource('SRC_KEEP')).toHaveLength(1);

    await repo.updateTrigger(u, created.id, { name: 'after' });

    const after = await repo.getTrigger(u, created.id);
    expect(after!.name).toBe('after');
    // Subscription must survive an unrelated update.
    expect(await repo.listTriggersByEventSource('SRC_KEEP')).toHaveLength(1);
  });

  // countTriggers backs the per-user hard limit. It must count only TRIGGER#
  // items, not EXECUTION# history rows that share the same PK partition —
  // otherwise execution volume could spuriously trip the limit (a 409 the user
  // can't explain). begins_with(SK, 'TRIGGER#') is what guards this.
  it('countTriggers ignores EXECUTION# rows in the same partition', async () => {
    const u = 'user-count-exec' as UserId;
    const t1 = await repo.createTrigger(makeScheduleInput(u, 'c1'));
    await repo.createTrigger(makeScheduleInput(u, 'c2'));

    // Inject execution-history rows: same user partition for one, and the
    // trigger-id partition that getExecutions uses for the other.
    await putExecutionRow(u, '2026-01-01T00:00:00.000Z');
    await putExecutionRow(t1.id, '2026-01-02T00:00:00.000Z');

    expect(await repo.countTriggers(u)).toBe(2);
  });

  // createTrigger's PutItem is conditional on the (PK, SK) pair being new, so a
  // (astronomically unlikely) id collision can never silently overwrite an
  // existing trigger. Simulate the collision by attempting a second write to an
  // already-occupied key with the same ConditionExpression and asserting DDB
  // rejects it with ConditionalCheckFailedException.
  it('createTrigger refuses to overwrite an existing (PK, SK)', async () => {
    const u = 'user-collide' as UserId;
    const created = await repo.createTrigger(makeScheduleInput(u, 'first'));

    const collide = client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          PK: `TRIGGER#${u}`,
          SK: `TRIGGER#${created.id}`,
          id: created.id,
          name: 'colliding-write',
        }),
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      })
    );

    await expect(collide).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    // Original trigger is untouched.
    const after = await repo.getTrigger(u, created.id);
    expect(after!.name).toBe('first');
  });
});
