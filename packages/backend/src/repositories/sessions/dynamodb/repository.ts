/**
 * `DynamoDBSessionsRepository` — the DynamoDB-backed {@link SessionsRepository}.
 *
 * IMPLEMENTATION DETAIL. Callers depend on the `SessionsRepository` interface
 * (see `../sessions-repository.ts`) and obtain an instance from the factory;
 * they never import this class directly.
 *
 * The module is intentionally free of any dependency on `config/index.ts`: the
 * `DynamoDBClient` and table name are injected via the constructor (DI), so it
 * stays integration-testable against DynamoDB Local. All key/marshalling
 * knowledge lives in `./item.ts`, not here.
 *
 * The backend only reads/deletes sessions; rows are written by the agent
 * package's SessionsService.
 */

import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
  GetItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { IdentityId } from '@moca/core';
import { createLogger } from '../../../libs/logger/index.js';
// Import directly from the pagination submodule (not the libs/http barrel) to
// keep this repository's dependency surface minimal and config-free.
import { encodePageToken } from '../../../libs/http/pagination.js';
import type { SessionsRepository, SessionListResult } from '../sessions-repository.js';
import type { SessionData } from '../types.js';
import { sessionKey, fromItem, toSummary } from './item.js';

const logger = createLogger('SessionsRepository');

export class DynamoDBSessionsRepository implements SessionsRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(client: DynamoDBClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  isConfigured(): boolean {
    return !!this.tableName;
  }

  /**
   * Cross-cutting policy for every data method: run the DynamoDB call, and on
   * failure log it with a per-method label and rethrow. Concentrating it here
   * keeps each public method to its happy path.
   */
  private async wrap<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      logger.error({ err: error }, `Error ${label}:`);
      throw error;
    }
  }

  async listSessions(
    userId: IdentityId,
    maxResults: number = 50,
    exclusiveStartKey?: Record<string, unknown>
  ): Promise<SessionListResult> {
    return this.wrap('listing sessions', async () => {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'userId-updatedAt-index',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: marshall({ ':userId': userId }),
          ScanIndexForward: false, // Sort descending (newest first)
          Limit: maxResults,
          // The caller decodes/validates the opaque page token (→ 400 on a
          // malformed token); here we receive the already-parsed key. The token
          // is the previously-emitted (marshalled) LastEvaluatedKey, so it is a
          // valid AttributeValue map for this low-level QueryCommand.
          ExclusiveStartKey: exclusiveStartKey as Record<string, AttributeValue> | undefined,
        })
      );

      const sessions = (result.Items || []).map((item) => toSummary(item));

      const hasMore = !!result.LastEvaluatedKey;
      // Use the shared encoder (same base64(JSON) format the triggers route
      // uses and that the sessions route's decodePageToken expects) so the
      // opaque token format has a single source of truth.
      const newNextToken = encodePageToken(result.LastEvaluatedKey);

      logger.info(`Listed ${sessions.length} sessions for user ${userId}`);

      return { sessions, nextToken: newNextToken, hasMore };
    });
  }

  async getSession(userId: IdentityId, sessionId: string): Promise<SessionData | null> {
    return this.wrap('getting session', async () => {
      const result = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: sessionKey(userId, sessionId),
        })
      );

      if (!result.Item) {
        return null;
      }

      return fromItem(result.Item);
    });
  }

  async deleteSession(userId: IdentityId, sessionId: string): Promise<void> {
    return this.wrap('deleting session', async () => {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: sessionKey(userId, sessionId),
        })
      );

      logger.info(`Deleted session ${sessionId} for user ${userId}`);
    });
  }
}
