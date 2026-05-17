/**
 * Sessions Service - DynamoDB operations for session management
 *
 * Partition key design:
 *   The DynamoDB partition key is the Cognito Identity Pool identityId
 *   (format: "REGION:uuid"), NOT the Cognito User Pool sub (UUID).
 *
 *   Reason: The IAM policy condition `dynamodb:LeadingKeys` uses the IAM variable
 *   `${cognito-identity.amazonaws.com:sub}`, which resolves to the identityId when
 *   credentials are issued via GetCredentialsForIdentity. The Cognito User Pool sub
 *   variable is NOT expanded in this context. Therefore, both the IAM condition and
 *   the actual DynamoDB key must use identityId for the access to be authorized.
 *
 *   getIdentityId(userId) resolves the identityId from the current request context
 *   (populated by scoped-credentials.ts during the GetCredentialsForIdentity exchange).
 */
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { config } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';
import { createUserScopedDynamoDBClient, getIdentityId } from '../libs/utils/scoped-credentials.js';

const logger = createLogger('SessionsService');
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
   * Cognito User Pool sub (UUID, no colons).
   * Stored alongside the identityId partition key so that downstream
   * consumers (e.g. session-stream-handler) can construct AppSync channel
   * paths without needing to reverse-look up the User Pool sub from the
   * identityId. AppSync rejects channel paths containing colons, so the
   * identityId (REGION:UUID) cannot be used directly.
   */
  channelUserId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for creating a new session
 */
export interface CreateSessionOptions {
  userId: string;
  sessionId: string;
  title: string;
  agentId?: string;
  storagePath?: string;
  sessionType?: SessionType;
  /** Cognito User Pool sub — used for AppSync channel paths (no colons). */
  channelUserId?: string;
}

/**
 * Sessions Service for DynamoDB operations
 */
export class SessionsService {
  private defaultClient: DynamoDBClient;
  private tableName: string;

  constructor(tableName?: string, region?: string) {
    const actualRegion = region || config.AWS_REGION;
    this.defaultClient = new DynamoDBClient({ region: actualRegion });
    this.tableName = tableName || config.SESSIONS_TABLE_NAME || '';

    if (!this.tableName) {
      logger.warn('SESSIONS_TABLE_NAME not configured');
    }
  }

  /**
   * Get a DynamoDB client with Identity Pool scoped credentials.
   * The credentials are restricted by IAM to items where the partition key
   * matches the identityId (dynamodb:LeadingKeys condition).
   */
  private async getClient(userId: string): Promise<DynamoDBClient> {
    return createUserScopedDynamoDBClient(userId);
  }

  /**
   * Resolve the DynamoDB partition key for the given user.
   *
   * Always returns the Identity Pool identityId (format: "REGION:uuid").
   * This matches the IAM condition `dynamodb:LeadingKeys = ${cognito-identity.amazonaws.com:sub}`
   * which IAM evaluates against the identityId, not the Cognito User Pool sub.
   */
  private async resolvePartitionKey(userId: string): Promise<string> {
    return getIdentityId(userId);
  }

  /**
   * Check if service is configured
   */
  isConfigured(): boolean {
    return !!this.tableName;
  }

  /**
   * Check if session exists
   */
  async sessionExists(userId: string, sessionId: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const [client, partitionKey] = await Promise.all([
        this.getClient(userId),
        this.resolvePartitionKey(userId),
      ]);
      const result = await client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: partitionKey, sessionId }),
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
   * Create a new session
   */
  async createSession(options: CreateSessionOptions): Promise<SessionData> {
    if (!this.isConfigured()) {
      throw new Error('SessionsService not configured: SESSIONS_TABLE_NAME is missing');
    }

    const now = new Date().toISOString();
    const partitionKey = await this.resolvePartitionKey(options.userId);

    const item: SessionData = {
      userId: partitionKey,
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
      const client = await this.getClient(options.userId);
      await client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(item, { removeUndefinedValues: true }),
          ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(sessionId)',
        })
      );

      logger.info(
        {
          userId: partitionKey,
          sessionId: options.sessionId,
          title: options.title,
        },
        'Created session:'
      );

      return item;
    } catch (error: unknown) {
      // If session already exists, this is not an error - just skip
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.info(
          {
            userId: partitionKey,
            sessionId: options.sessionId,
          },
          'Session already exists, skipping creation:'
        );
        // Return existing session data
        return {
          ...item,
          createdAt: now, // We don't know actual createdAt, but it's fine
        };
      }
      logger.error({ error }, 'Error creating session:');
      throw error;
    }
  }

  /**
   * Update session's updatedAt timestamp
   */
  async updateSessionTimestamp(userId: string, sessionId: string): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn('Not configured, skipping timestamp update');
      return;
    }

    const now = new Date().toISOString();

    try {
      const [client, partitionKey] = await Promise.all([
        this.getClient(userId),
        this.resolvePartitionKey(userId),
      ]);
      await client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: partitionKey, sessionId }),
          UpdateExpression: 'SET updatedAt = :updatedAt',
          ExpressionAttributeValues: marshall({ ':updatedAt': now }),
          ConditionExpression: 'attribute_exists(userId) AND attribute_exists(sessionId)',
        })
      );

      logger.debug(
        {
          userId: partitionKey,
          sessionId,
          updatedAt: now,
        },
        'Updated session timestamp:'
      );
    } catch (error: unknown) {
      // If session doesn't exist, log warning but don't throw
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.warn(
          {
            userId,
            sessionId,
          },
          'Session not found for timestamp update:'
        );
        return;
      }
      logger.error({ error }, 'Error updating session timestamp:');
      throw error;
    }
  }

  /**
   * Get session data
   */
  async getSession(userId: string, sessionId: string): Promise<SessionData | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const [client, partitionKey] = await Promise.all([
        this.getClient(userId),
        this.resolvePartitionKey(userId),
      ]);
      const result = await client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: partitionKey, sessionId }),
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
   * Update session's agentId, storagePath and timestamp
   * Used when continuing an existing session with potentially different agent/storage settings
   */
  async updateSessionAgentAndStorage(
    userId: string,
    sessionId: string,
    agentId?: string,
    storagePath?: string
  ): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn('Not configured, skipping agent/storage update');
      return;
    }

    const now = new Date().toISOString();

    // Build update expression dynamically based on provided values
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
      const [client, partitionKey] = await Promise.all([
        this.getClient(userId),
        this.resolvePartitionKey(userId),
      ]);
      await client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: partitionKey, sessionId }),
          UpdateExpression: `SET ${updateParts.join(', ')}`,
          ExpressionAttributeValues: marshall(expressionValues, { removeUndefinedValues: true }),
          ConditionExpression: 'attribute_exists(userId) AND attribute_exists(sessionId)',
        })
      );

      logger.info(
        {
          userId: partitionKey,
          sessionId,
          agentId,
          storagePath,
          updatedAt: now,
        },
        'Updated session agentId/storagePath:'
      );
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.warn(
          {
            userId,
            sessionId,
          },
          'Session not found for agent/storage update:'
        );
        return;
      }
      logger.error({ error }, 'Error updating session agent/storage:');
      throw error;
    }
  }

  /**
   * Update session title
   */
  async updateSessionTitle(userId: string, sessionId: string, title: string): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn('Not configured, skipping title update');
      return;
    }

    const now = new Date().toISOString();

    try {
      const [client, partitionKey] = await Promise.all([
        this.getClient(userId),
        this.resolvePartitionKey(userId),
      ]);
      await client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId: partitionKey, sessionId }),
          UpdateExpression: 'SET title = :title, updatedAt = :updatedAt',
          ExpressionAttributeValues: marshall({
            ':title': title,
            ':updatedAt': now,
          }),
          ConditionExpression: 'attribute_exists(userId) AND attribute_exists(sessionId)',
        })
      );

      logger.info(
        {
          userId: partitionKey,
          sessionId,
          title,
        },
        'Updated session title:'
      );
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        logger.warn(
          {
            userId,
            sessionId,
          },
          'Session not found for title update:'
        );
        return;
      }
      logger.error({ error }, 'Error updating session title:');
      throw error;
    }
  }
}

// Singleton instance
let sessionsServiceInstance: SessionsService | null = null;

/**
 * Get or create SessionsService singleton
 */
export function getSessionsService(): SessionsService {
  if (!sessionsServiceInstance) {
    sessionsServiceInstance = new SessionsService();
  }
  return sessionsServiceInstance;
}
