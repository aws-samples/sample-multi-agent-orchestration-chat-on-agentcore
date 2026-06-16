/**
 * Sessions domain model — what a session IS, independent of how it is stored.
 *
 * These types are shared by the `SessionsRepository` interface
 * (`./sessions-repository.ts`) and its DynamoDB implementation (`./dynamodb/`).
 * They carry no persistence or Cognito knowledge: the partition key, scoped
 * credentials, and identityId resolution are the composition layer's concern.
 *
 * The id fields are branded (`@moca/core`) and MUST match the backend's
 * `SessionData` model (packages/backend/src/repositories/sessions/types.ts) —
 * the agent writes these rows and the backend reads them, so a drift in the
 * domain model between the two packages is a latent cross-package bug. Note the
 * `userId` partition key is the Cognito Identity Pool `IdentityId`, NOT the
 * User Pool `UserId`; `channelUserId` is the User Pool `UserId`. They are
 * distinct brands precisely so the two can never be swapped by accident.
 */

import type { IdentityId, AgentId, UserId } from '@moca/core';

/**
 * Session type
 */
export type SessionType = 'user' | 'event' | 'subagent';

/**
 * Session data stored in DynamoDB
 */
export interface SessionData {
  /** Partition key: the Cognito Identity Pool identityId ("REGION:UUID"). */
  userId: IdentityId;
  sessionId: string;
  title: string;
  agentId?: AgentId;
  storagePath?: string;
  sessionType?: SessionType;
  /**
   * Cognito User Pool sub (UUID, no colons). Stored alongside the identityId
   * partition key so downstream consumers (e.g. session-stream-handler) can
   * construct AppSync channel paths without reverse-looking-up the User Pool
   * sub from the identityId (AppSync rejects channel paths containing colons,
   * so the identityId "REGION:UUID" cannot be used directly).
   */
  channelUserId?: UserId;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single session as surfaced to a session listing. A read-only projection of
 * {@link SessionData} that omits the partition key (`userId`) and internal
 * routing field (`channelUserId`) so the listing only exposes display data.
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
