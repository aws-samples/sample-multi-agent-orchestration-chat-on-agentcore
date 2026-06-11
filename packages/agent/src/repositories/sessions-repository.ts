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
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { createLogger } from '../libs/logger/index.js';

const logger = createLogger('SessionsRepository');

/**
 * Name of the GSI used to list a user's sessions newest-first. Mirrors the
 * index the Backend's read path queries (see
 * packages/backend/src/repositories/sessions/dynamodb/repository.ts) and the
 * CDK table definition.
 */
const USER_UPDATED_AT_INDEX = 'userId-updatedAt-index';

/**
 * Encode a DynamoDB LastEvaluatedKey into an opaque base64 page token.
 * Returns `undefined` when there are no further pages. Uses the same
 * base64(JSON) format as the Backend sessions route so a token is portable.
 */
function encodePageToken(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key)).toString('base64');
}

/**
 * Decode an opaque base64 page token into a DynamoDB ExclusiveStartKey.
 * Returns `undefined` for a missing token; throws on a malformed one so the
 * caller can surface a clear error rather than silently scanning from the top.
 */
function decodePageToken(token: string | undefined): Record<string, AttributeValue> | undefined {
  if (!token) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
  } catch {
    throw new Error('Invalid pagination token');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Invalid pagination token');
  }
  return decoded as Record<string, AttributeValue>;
}

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
 * A single session as surfaced to a session listing. A read-only projection of
 * {@link SessionData} that omits the partition key (`userId`) and internal
 * routing field (`channelUserId`) so the listing only exposes display data.
 */
export interface SessionSummary {
  sessionId: string;
  title: string;
  agentId?: string;
  storagePath?: string;
  sessionType?: SessionType;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result of {@link SessionsRepository.listSessions}: a page of summaries plus an
 * opaque `nextToken` (absent when the last page has been reached).
 */
export interface SessionListResult {
  sessions: SessionSummary[];
  nextToken?: string;
  hasMore: boolean;
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
   * List this user's sessions, newest first (by `updatedAt`), with opaque-key
   * pagination. Queries the {@link USER_UPDATED_AT_INDEX} GSI scoped to the
   * repository's partition key, so it only ever returns the caller's own
   * sessions. `maxResults` bounds the page size; pass the returned `nextToken`
   * back in to fetch the next page.
   */
  async listSessions(maxResults = 20, nextToken?: string): Promise<SessionListResult> {
    try {
      const exclusiveStartKey = decodePageToken(nextToken);
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: USER_UPDATED_AT_INDEX,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: marshall({ ':userId': this.partitionKey }),
          ScanIndexForward: false, // newest first
          Limit: maxResults,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      const sessions: SessionSummary[] = (result.Items || []).map((item) => {
        const data = unmarshall(item) as SessionData;
        return {
          sessionId: data.sessionId,
          title: data.title,
          agentId: data.agentId,
          storagePath: data.storagePath,
          sessionType: data.sessionType,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
      });

      const hasMore = !!result.LastEvaluatedKey;
      logger.debug(
        { userId: this.partitionKey, count: sessions.length, hasMore },
        'Listed sessions:'
      );

      return {
        sessions,
        nextToken: encodePageToken(result.LastEvaluatedKey),
        hasMore,
      };
    } catch (error) {
      logger.error({ error }, 'Error listing sessions:');
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
