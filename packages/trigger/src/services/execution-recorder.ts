/**
 * Service for recording trigger execution history in DynamoDB
 * Simplified: records execution facts only (no status management)
 */

import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import type { TriggerId } from '@moca/core';
import { TriggerExecution } from '../types/index.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('ExecutionRecorder');

/** Maximum size for eventPayload field (~10KB) */
const MAX_EVENT_PAYLOAD_SIZE = 10 * 1024;

/**
 * Truncate a JSON-serializable value to fit within maxBytes.
 * If the serialized JSON exceeds maxBytes, it is cut and suffixed with "[truncated]".
 */
function truncateJson(value: unknown, maxBytes: number): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= maxBytes) {
      return json;
    }
    const suffix = '\n... [truncated]';
    return json.slice(0, maxBytes - suffix.length) + suffix;
  } catch {
    return JSON.stringify({ error: 'Failed to serialize event payload' });
  }
}

/**
 * Service for managing trigger execution records
 */
export class ExecutionRecorder {
  private readonly dynamoClient: DynamoDBClient;
  private readonly tableName: string;

  constructor(tableName: string, region?: string) {
    this.tableName = tableName;
    const clientRegion =
      region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-northeast-1';
    log.info({ region: clientRegion }, 'Initializing DynamoDB client');
    this.dynamoClient = new DynamoDBClient({
      region: clientRegion,
    });
  }

  /**
   * Record a trigger execution (success or failure)
   * Single PutItem call — no subsequent status updates needed
   * @param errorMessage - If provided, indicates the execution failed
   */
  async recordExecution(
    triggerId: TriggerId,
    sessionId: string | undefined,
    event: unknown,
    errorMessage?: string
  ): Promise<string> {
    const executionId = uuidv7();
    const now = new Date().toISOString();

    // TTL: 30 days from now
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    const eventPayload = truncateJson(event, MAX_EVENT_PAYLOAD_SIZE);

    const execution: TriggerExecution = {
      PK: `TRIGGER#${triggerId}`,
      SK: `EXECUTION#${executionId}`,
      triggerId,
      executionId,
      executedAt: now,
      sessionId,
      eventPayload,
      errorMessage,
      ttl,
    };

    await this.dynamoClient.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(execution, { removeUndefinedValues: true }),
      })
    );

    log.info(
      {
        triggerId,
        executionId,
        sessionId,
        eventPayloadSize: eventPayload.length,
        hasError: !!errorMessage,
      },
      'Execution recorded'
    );

    return executionId;
  }

  /**
   * Update trigger's last execution timestamp
   */
  async updateTriggerLastExecution(userId: string, triggerId: TriggerId): Promise<void> {
    const now = new Date().toISOString();

    try {
      await this.dynamoClient.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({
            PK: `TRIGGER#${userId}`,
            SK: `TRIGGER#${triggerId}`,
          }),
          UpdateExpression: 'SET lastExecutedAt = :lastExecutedAt',
          ExpressionAttributeValues: marshall({
            ':lastExecutedAt': now,
          }),
        })
      );

      log.info(
        { userId, triggerId, lastExecutedAt: now },
        'Trigger last execution updated'
      );
    } catch (error) {
      log.warn({ err: error }, 'Failed to update trigger last execution (non-critical)');
    }
  }

  /**
   * Create ExecutionRecorder from environment variables
   */
  static fromEnvironment(): ExecutionRecorder {
    const tableName = process.env.TRIGGERS_TABLE_NAME;
    const region = process.env.AWS_REGION;

    if (!tableName) {
      throw new Error('TRIGGERS_TABLE_NAME environment variable is required');
    }

    return new ExecutionRecorder(tableName, region);
  }
}
