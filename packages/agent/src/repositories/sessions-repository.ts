/**
 * Sessions Repository — pure DynamoDB data-access for session metadata.
 *
 * Intentionally free of `config`, Cognito, and request-context: the
 * `DynamoDBClient`, table name, and the already-resolved partition key are all
 * injected. In production the partition key is the Cognito Identity Pool
 * identityId (see services/sessions-service.ts, which resolves per-user scoped
 * credentials + identityId and constructs one repository per operation). In
 * tests the client points at DynamoDB Local and the partition key is a literal,
 * so the DynamoDB semantics (ConditionExpressions, dynamic UpdateExpression,
 * item shape) can be verified without Cognito.
 *
 * Per-user isolation via the IAM `dynamodb:LeadingKeys` condition is enforced by
 * the *credentials* the injected client carries — that is the composition
 * layer's responsibility and is out of scope for this repository.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { createLogger } from '../libs/logger/index.js';

const logger = createLogger('SessionsRepository');

/**
 * Session type
 */
export type SessionType = 'user' | 'event' | 'subagent';

/**
 * Session data stored in DynamoDB
 */
export interface SessionData {
  userId: string;
  sessionId: string;
  title: string;
  agentId?: string;
  storagePath?: string;
  sessionType?: SessionType;
  /**
   * Cognito User Pool sub (UUID, no colons). Stored alongside the identityId
   * partition key so downstream consumers (e.g. session-stream-handler) can
   * construct AppSync channel paths without reverse-looking-up the User Pool
   * sub from the identityId (AppSync rejects channel paths containing colons,
   * so the identityId "REGION:UUID" cannot be used directly).
   */
  channelUserId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for creating a new session. The partition key is NOT part of this —
 * it is fixed on the repository instance.
 */
export interface CreateSessionOptions {
  sessionId: string;
  title: string;
  agentId?: string;
  storagePath?: string;
  sessionType?: SessionType;
  /** Cognito User Pool sub — used for AppSync channel paths (no colons). */
  channelUserId?: string;
}

/**
 * Sessions Repository. Bound to a single partition key (one user) for its
 * lifetime; the composition layer creates one per operation.
 */
export class SessionsRepository {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    private readonly partitionKey: string
  ) {}

  /**
   * Check if a session exists (key-only projection, no payload).
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const result = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: this.partitionKey, sessionId }),
          ProjectionExpression: 'userId',
        })
      );
      return !!result.Item;
    } catch (error) {
      logger.error({ error }, 'Error checking session existence:');
      return false;
    }
  }

  /**
   * Create a new session. Idempotent: a duplicate (userId, sessionId) is left
   * untouched (ConditionExpression) and the supplied item is returned rather
   * than throwing, matching the previous SessionsService behaviour.
   */
  async createSession(options: CreateSessionOptions): Promise<SessionData> {
    const now = new Date().toISOString();

    const item: SessionData = {
      userId: this.partitionKey,
      sessionId: options.sessionId,
      title: options.title,
      agentId: options.agentId,
      storagePath: options.storagePath,
      sessionType: options.sessionType,
      channelUserId: options.channelUserId,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(item, { removeUndefinedValues: true }),
          ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(sessionId)',
        })
      );

      logger.info(
        { userId: this.partitionKey, sessionId: options.sessionId, title: options.title },
        'Created session:'
      );

      return item;
    } catch (error: unknown) {
      // If session already exists, this is not an error - just skip.
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.info(
          { userId: this.partitionKey, sessionId: options.sessionId },
          'Session already exists, skipping creation:'
        );
        return { ...item, createdAt: now };
      }
      logger.error({ error }, 'Error creating session:');
      throw error;
    }
  }

  /**
   * Update session's updatedAt timestamp. No-op (warn) if the session is gone.
   */
  async updateSessionTimestamp(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: this.partitionKey, sessionId }),
          UpdateExpression: 'SET updatedAt = :updatedAt',
          ExpressionAttributeValues: marshall({ ':updatedAt': now }),
          ConditionExpression: 'attribute_exists(userId) AND attribute_exists(sessionId)',
        })
      );
      logger.debug(
        { userId: this.partitionKey, sessionId, updatedAt: now },
        'Updated session timestamp:'
      );
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.warn({ sessionId }, 'Session not found for timestamp update:');
        return;
      }
      logger.error({ error }, 'Error updating session timestamp:');
      throw error;
    }
  }

  /**
   * Get session data, or null when absent.
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      const result = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: this.partitionKey, sessionId }),
        })
      );
      if (!result.Item) {
        return null;
      }
      return unmarshall(result.Item) as SessionData;
    } catch (error) {
      logger.error({ error }, 'Error getting session:');
      throw error;
    }
  }

  /**
   * Update agentId / storagePath (and updatedAt). Only the provided fields are
   * written. No-op (warn) if the session is gone.
   */
  async updateSessionAgentAndStorage(
    sessionId: string,
    agentId?: string,
    storagePath?: string
  ): Promise<void> {
    const now = new Date().toISOString();

    const updateParts: string[] = ['updatedAt = :updatedAt'];
    const expressionValues: Record<string, string | undefined> = { ':updatedAt': now };

    if (agentId !== undefined) {
      updateParts.push('agentId = :agentId');
      expressionValues[':agentId'] = agentId;
    }
    if (storagePath !== undefined) {
      updateParts.push('storagePath = :storagePath');
      expressionValues[':storagePath'] = storagePath;
    }

    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: this.partitionKey, sessionId }),
          UpdateExpression: `SET ${updateParts.join(', ')}`,
          ExpressionAttributeValues: marshall(expressionValues, { removeUndefinedValues: true }),
          ConditionExpression: 'attribute_exists(userId) AND attribute_exists(sessionId)',
        })
      );
      logger.info(
        { userId: this.partitionKey, sessionId, agentId, storagePath, updatedAt: now },
        'Updated session agentId/storagePath:'
      );
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.warn({ sessionId }, 'Session not found for agent/storage update:');
        return;
      }
      logger.error({ error }, 'Error updating session agent/storage:');
      throw error;
    }
  }

  /**
   * Update session title (and updatedAt). No-op (warn) if the session is gone.
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: this.partitionKey, sessionId }),
          UpdateExpression: 'SET title = :title, updatedAt = :updatedAt',
          ExpressionAttributeValues: marshall({ ':title': title, ':updatedAt': now }),
          ConditionExpression: 'attribute_exists(userId) AND attribute_exists(sessionId)',
        })
      );
      logger.info({ userId: this.partitionKey, sessionId, title }, 'Updated session title:');
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.warn({ sessionId }, 'Session not found for title update:');
        return;
      }
      logger.error({ error }, 'Error updating session title:');
      throw error;
    }
  }
}
