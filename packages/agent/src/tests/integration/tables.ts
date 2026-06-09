/**
 * Table provisioning helpers for DynamoDB Local integration tests (agent).
 *
 * The Sessions key schema mirrors the CDK construct so the tests exercise the
 * same layout as production:
 *   packages/cdk/lib/constructs/storage/sessions-table.ts
 *     PK userId (HASH) / SK sessionId (RANGE)
 *     GSI 'userId-updatedAt-index' (userId HASH / updatedAt RANGE, ALL)
 *
 * Every test run provisions a freshly named table so suites are isolated.
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
 * Create the Sessions table with the CDK-matching schema. TTL is not used by
 * the sessions table, so none is configured here.
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

/** Best-effort table teardown; ignores "table not found" style errors. */
export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    // Table may already be gone; nothing to clean up.
  }
}
