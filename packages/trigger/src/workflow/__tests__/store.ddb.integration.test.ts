/**
 * WorkflowStore against DynamoDB Local (npm run test:ddb).
 * Pins the conditional writes that keep a cancelled workflow cancelled.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { workflowKeys, type WorkflowRecord, type WorkflowStepState } from '@moca/tool-definitions';
import { WorkflowStore } from '../store.js';

const TABLE = `workflows-${Date.now()}`;
let client: DynamoDBClient;
let store: WorkflowStore;

const header = (status: WorkflowRecord['status']): WorkflowRecord => ({
  workflowId: 'wf-1',
  userId: 'user-1',
  status,
  spec: { goal: 'g', steps: [{ id: 's', agentId: 'a', prompt: 'p' }] },
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
});
const step = (status: WorkflowStepState['status']): WorkflowStepState => ({
  workflowId: 'wf-1',
  stepId: 's',
  status,
  runs: 1,
  iteration: 0,
  updatedAt: new Date().toISOString(),
});

async function putHeader(record: WorkflowRecord) {
  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall({ PK: workflowKeys.pk('user-1'), SK: workflowKeys.header('wf-1'), ...record }),
    })
  );
}

beforeAll(async () => {
  client = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT, region: 'us-east-1' });
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    })
  );
  store = new WorkflowStore(client, TABLE);
});

afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: TABLE }));
  client.destroy();
});

beforeEach(async () => {
  await putHeader(header('running'));
});

describe('WorkflowStore', () => {
  it('saves and lists step states', async () => {
    await store.saveStep('user-1', { ...step('running'), sessionId: 'sess' });
    await store.saveStep('user-1', { ...step('done'), output: 'out' });
    expect(await store.listSteps('user-1', 'wf-1')).toEqual([
      expect.objectContaining({ stepId: 's', status: 'done', output: 'out' }),
    ]);
  });

  it('never overwrites a cancelled step', async () => {
    await store.saveStep('user-1', step('cancelled'));
    await store.saveStep('user-1', step('running'));
    await store.saveStep('user-1', { ...step('done'), output: 'late' });
    const [saved] = await store.listSteps('user-1', 'wf-1');
    expect(saved.status).toBe('cancelled');
    expect(saved.output).toBeUndefined();
  });

  it('updates the header status with result fields', async () => {
    await store.setStatus('user-1', 'wf-1', 'completed', { result: 'summary' });
    expect(await store.get('user-1', 'wf-1')).toMatchObject({
      status: 'completed',
      result: 'summary',
      completedAt: expect.any(String),
    });
  });

  it('never moves a cancelled workflow to another status', async () => {
    await store.setStatus('user-1', 'wf-1', 'cancelled');
    await store.setStatus('user-1', 'wf-1', 'completed', { result: 'late' });
    expect(await store.get('user-1', 'wf-1')).toMatchObject({ status: 'cancelled' });
    expect((await store.get('user-1', 'wf-1'))?.result).toBeUndefined();
  });

  it('ignores status updates for a workflow that does not exist', async () => {
    await expect(store.setStatus('user-1', 'wf-missing', 'failed')).resolves.toBeUndefined();
    expect(await store.get('user-1', 'wf-missing')).toBeNull();
  });
});
