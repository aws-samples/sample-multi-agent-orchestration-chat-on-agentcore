/**
 * Sessions Service — per-user composition layer over {@link SessionsRepository}.
 *
 * The data-access logic lives behind the `SessionsRepository` interface
 * (repositories/sessions/, with a pure, config/Cognito-free DynamoDB
 * implementation under repositories/sessions/dynamodb/). This layer owns the
 * agent-specific concerns the repository deliberately doesn't know about:
 *
 *   1. Resolving per-user, Identity-Pool-scoped DynamoDB credentials
 *      (createUserScopedDynamoDBClient) — this is what enforces per-user
 *      isolation via the IAM `dynamodb:LeadingKeys` condition.
 *   2. Resolving the DynamoDB partition key (getIdentityId) — the Cognito
 *      Identity Pool identityId, NOT the User Pool sub, because IAM expands
 *      `${cognito-identity.amazonaws.com:sub}` to the identityId.
 *
 * Both are resolved per operation (the credential layer caches internally), and
 * a short-lived repository bound to that user is constructed to run the call.
 * The public surface keeps the `userId`-first {@link ISessionsService} contract
 * so existing callers (session-persistence-hook, etc.) are unchanged.
 */

import type { AgentId, UserId } from '@moca/core';
import { config } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';
import { createUserScopedDynamoDBClient, getIdentityId } from '../libs/utils/scoped-credentials.js';
import type { SessionsRepository } from '../repositories/sessions/index.js';
import { DynamoDBSessionsRepository } from '../repositories/sessions/dynamodb/index.js';

export type {
  SessionType,
  SessionData,
  SessionSummary,
  SessionListResult,
} from '../repositories/sessions/index.js';

const logger = createLogger('SessionsService');

/**
 * Options for creating a new session (userId-first public contract).
 */
export interface CreateSessionOptions {
  userId: string;
  sessionId: string;
  title: string;
  agentId?: string;
  storagePath?: string;
  sessionType?: 'user' | 'event' | 'subagent';
  /** Cognito User Pool sub — used for AppSync channel paths (no colons). */
  channelUserId?: string;
}

/**
 * Sessions Service for DynamoDB operations.
 */
export class SessionsService {
  private readonly tableName: string;

  constructor(tableName?: string) {
    this.tableName = tableName || config.SESSIONS_TABLE_NAME || '';
    if (!this.tableName) {
      logger.warn('SESSIONS_TABLE_NAME not configured');
    }
  }

  /**
   * Check if the service is configured with a table name.
   */
  isConfigured(): boolean {
    return !!this.tableName;
  }

  /**
   * Build a repository bound to the given user: resolves the Identity-Pool
   * scoped client and the identityId partition key, then constructs the
   * (short-lived) repository. The credential layer caches internally, so this
   * does not add a round-trip per call beyond the first.
   */
  private async repositoryForUser(userId: string): Promise<SessionsRepository> {
    const [client, partitionKey] = await Promise.all([
      createUserScopedDynamoDBClient(userId),
      getIdentityId(userId),
    ]);
    return new DynamoDBSessionsRepository(client, this.tableName, partitionKey);
  }

  async sessionExists(userId: string, sessionId: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }
    const repo = await this.repositoryForUser(userId);
    return repo.sessionExists(sessionId);
  }

  async createSession(options: CreateSessionOptions) {
    if (!this.isConfigured()) {
      throw new Error('SessionsService not configured: SESSIONS_TABLE_NAME is missing');
    }
    const repo = await this.repositoryForUser(options.userId);
    // The service's public contract is intentionally string-typed (userId-first,
    // loosely-typed external surface); the repository's domain model is branded.
    // This is the composition boundary, so brand the ids on the way in — same
    // pattern as request-context (`sub as UserId`). channelUserId originates as
    // a UserId (getCurrentContext().userId) and agentId as a plain id string.
    return repo.createSession({
      sessionId: options.sessionId,
      title: options.title,
      agentId: options.agentId as AgentId | undefined,
      storagePath: options.storagePath,
      sessionType: options.sessionType,
      channelUserId: options.channelUserId as UserId | undefined,
    });
  }

  async updateSessionTimestamp(userId: string, sessionId: string): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn('Not configured, skipping timestamp update');
      return;
    }
    const repo = await this.repositoryForUser(userId);
    return repo.updateSessionTimestamp(sessionId);
  }

  async getSession(userId: string, sessionId: string) {
    if (!this.isConfigured()) {
      return null;
    }
    const repo = await this.repositoryForUser(userId);
    return repo.getSession(sessionId);
  }

  /**
   * List a user's sessions newest-first with opaque-token pagination. Returns
   * an empty page (no token) when the service is not configured.
   */
  async listSessions(userId: string, maxResults?: number, nextToken?: string) {
    if (!this.isConfigured()) {
      logger.warn('Not configured, returning empty session list');
      return { sessions: [], hasMore: false };
    }
    const repo = await this.repositoryForUser(userId);
    return repo.listSessions(maxResults, nextToken);
  }

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
    const repo = await this.repositoryForUser(userId);
    // Brand at the composition boundary (see createSession above).
    return repo.updateSessionAgentAndStorage(sessionId, agentId as AgentId | undefined, storagePath);
  }

  async updateSessionTitle(userId: string, sessionId: string, title: string): Promise<void> {
    if (!this.isConfigured()) {
      logger.warn('Not configured, skipping title update');
      return;
    }
    const repo = await this.repositoryForUser(userId);
    return repo.updateSessionTitle(sessionId, title);
  }
}

// Singleton instance
let sessionsServiceInstance: SessionsService | null = null;

/**
 * Get or create SessionsService singleton.
 */
export function getSessionsService(): SessionsService {
  if (!sessionsServiceInstance) {
    sessionsServiceInstance = new SessionsService();
  }
  return sessionsServiceInstance;
}
