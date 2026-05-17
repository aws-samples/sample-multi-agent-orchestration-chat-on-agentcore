/**
 * Sessions DynamoDB Service
 * Service for managing session data in DynamoDB
 */

import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { AgentId, IdentityId } from '@moca/core';
import { config } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';

const logger = createLogger('SessionsDynamoDBService');

/**
 * Session type
 */
export type SessionType = 'user' | 'event' | 'subagent';

/**
 * Session data stored in DynamoDB
 */
export interface SessionData {
  userId: IdentityId;
  sessionId: string;
  title: string;
  agentId?: AgentId;
  storagePath?: string;
  sessionType?: SessionType;
  createdAt: string;
  updatedAt: string;
}

/**
 * Session summary for frontend display
 */
export interface SessionSummary {
  sessionId: string;
  title: string;
  agentId?: AgentId;
  storagePath?: string;
  sessionType?: SessionType;
  createdAt: string;
  updatedAt: string;
}

/**
 * Session list result with pagination
 */
export interface SessionListResult {
  sessions: SessionSummary[];
  nextToken?: string;
  hasMore: boolean;
}

/**
 * Sessions DynamoDB Service
 */
export class SessionsDynamoDBService {
  private client: DynamoDBClient;
  private tableName: string;

  constructor() {
    this.client = new DynamoDBClient({ region: config.AWS_REGION });
    this.tableName = config.SESSIONS_TABLE_NAME || '';
  }

  /**
   * Check if service is configured
   */
  isConfigured(): boolean {
    return !!this.tableName;
  }

  /**
   * List sessions for a user (sorted by updatedAt descending)
   */
  async listSessions(
    userId: IdentityId,
    maxResults: number = 50,
    nextToken?: string
  ): Promise<SessionListResult> {
    if (!this.isConfigured()) {
      logger.warn('SESSIONS_TABLE_NAME not configured');
      return { sessions: [], hasMore: false };
    }

    try {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'userId-updatedAt-index',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: marshall({ ':userId': userId }),
          ScanIndexForward: false, // Sort descending (newest first)
          Limit: maxResults,
          ExclusiveStartKey: nextToken
            ? JSON.parse(Buffer.from(nextToken, 'base64').toString())
            : undefined,
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
      const newNextToken = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined;

      logger.info(`Listed ${sessions.length} sessions for user ${userId}`);

      return {
        sessions,
        nextToken: newNextToken,
        hasMore,
      };
    } catch (error) {
      logger.error({ err: error }, 'Error listing sessions:');
      throw error;
    }
  }

  /**
   * Get a single session
   */
  async getSession(userId: IdentityId, sessionId: string): Promise<SessionData | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const result = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId, sessionId }),
        })
      );

      if (!result.Item) {
        return null;
      }

      return unmarshall(result.Item) as SessionData;
    } catch (error) {
      logger.error({ err: error }, 'Error getting session:');
      throw error;
    }
  }

  /**
   * Delete a session from DynamoDB
   */
  async deleteSession(userId: IdentityId, sessionId: string): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn('SESSIONS_TABLE_NAME not configured, skipping delete');
      return;
    }

    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: marshall({ userId, sessionId }),
        })
      );

      logger.info(`Deleted session ${sessionId} for user ${userId}`);
    } catch (error) {
      logger.error({ err: error }, 'Error deleting session:');
      throw error;
    }
  }
}

// Singleton instance
let sessionsDynamoDBServiceInstance: SessionsDynamoDBService | null = null;

/**
 * Get or create SessionsDynamoDBService singleton
 */
export function getSessionsDynamoDBService(): SessionsDynamoDBService {
  if (!sessionsDynamoDBServiceInstance) {
    sessionsDynamoDBServiceInstance = new SessionsDynamoDBService();
  }
  return sessionsDynamoDBServiceInstance;
}
