/**
 * Build a DynamoDBClient pointed at the DynamoDB Local container started by
 * global-setup. Reads `DYNAMODB_ENDPOINT` from the environment, so it must be
 * called from inside a test (after globalSetup has run).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

export function makeLocalClient(): DynamoDBClient {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'DYNAMODB_ENDPOINT is not set — global-setup did not run or DynamoDB Local failed to start.'
    );
  }
  return new DynamoDBClient({
    endpoint,
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}
