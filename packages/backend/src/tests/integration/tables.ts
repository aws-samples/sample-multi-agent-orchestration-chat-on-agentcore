/**
 * Table provisioning helpers for DynamoDB Local integration tests.
 *
 * The key schemas here MUST mirror the CDK construct definitions so that the
 * integration tests exercise the same partition/sort/GSI layout as production:
 *   - Triggers table → packages/cdk/lib/constructs/storage/triggers-table.ts
 *   - Agents table   → packages/cdk/lib/constructs/storage/agents-table.ts
 *
 * Every test run provisions a freshly named table (see `uniqueTableName`) so
 * suites are isolated from each other and from any prior local state.
 */

import { randomUUID } from 'node:crypto';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

/** Build a collision-resistant table name for a single test run. */
export function uniqueTableName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create the Triggers table with the CDK-matching schema:
 *   PK (HASH) / SK (RANGE), plus GSI1 and GSI2 (both ALL projection).
 * Billing mode is PAY_PER_REQUEST to match production and to avoid having to
 * specify throughput. TTL ('ttl') is not enforced by DynamoDB Local in a
 * timely manner, so tests assert on the attribute value, not on auto-deletion.
 */
export async function createTriggersTable(
  client: DynamoDBClient,
  tableName: string
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );

  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
}

/**
 * Create the Sessions table with the CDK-matching schema:
 *   PK userId (HASH) / SK sessionId (RANGE), plus the
 *   'userId-updatedAt-index' GSI (userId HASH / updatedAt RANGE, ALL).
 * Mirrors packages/cdk/lib/constructs/storage/sessions-table.ts.
 */
export async function createSessionsTable(
  client: DynamoDBClient,
  tableName: string
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'sessionId', AttributeType: 'S' },
        { AttributeName: 'updatedAt', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'sessionId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'userId-updatedAt-index',
          KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );

  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
}

/**
 * Create the Agents table with the CDK-matching schema:
 *   userId (HASH) / agentId (RANGE), plus the 'isShared-createdAt-index' GSI
 *   (isShared HASH / createdAt RANGE, ALL projection). `isShared` is stored as
 *   a string ('true'/'false') because DynamoDB cannot key on a boolean.
 * Mirrors packages/cdk/lib/constructs/storage/agents-table.ts.
 */
export async function createAgentsTable(
  client: DynamoDBClient,
  tableName: string
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'agentId', AttributeType: 'S' },
        { AttributeName: 'isShared', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'agentId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'isShared-createdAt-index',
          KeySchema: [
            { AttributeName: 'isShared', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  );

  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
}

/** Best-effort table teardown; ignores "table not found" style errors. */
export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    // Table may already be gone; nothing to clean up.
  }
}
