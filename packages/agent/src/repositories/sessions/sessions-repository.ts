/**
 * `SessionsRepository` — the behaviour contract for session persistence.
 *
 * THIS FILE IS THE WHOLE PUBLIC SURFACE. To *use* sessions you only need this
 * interface plus the domain types in `./types.ts`; you never need to open the
 * `./dynamodb/` implementation. The composition layer
 * (`services/sessions-service.ts`) depends on this interface, not on a concrete
 * class, so the storage engine can be swapped (a second implementation, an
 * in-memory fake for unit tests) without touching callers.
 *
 * Contract notes that hold for ANY implementation:
 * - A repository instance is bound to ONE user for its lifetime: the partition
 *   key (the Cognito Identity Pool identityId in production) is fixed at
 *   construction, NOT passed per call. The composition layer creates one
 *   short-lived repository per operation. This is why no method takes a
 *   `userId` — every call already operates within the bound user's partition.
 * - A session is addressed by `(boundPartitionKey, sessionId)`.
 * - `createSession` is idempotent: a duplicate `sessionId` is left untouched and
 *   the supplied item is returned rather than throwing.
 * - The `updateSession*` methods are existence-guarded no-ops: updating a
 *   missing session warns and returns without throwing (and never resurrects
 *   the row).
 * - A missing session reads as `null` (getSession).
 */

import type { AgentId, UserId } from '@moca/core';
import type { SessionData, SessionSummary } from './types.js';

// --- Method input/output types -----------------------------------------------
// How you OPERATE on sessions, as opposed to the domain MODEL in `./types.ts`.
// These live with the interface because they only make sense paired with it.

/**
 * Options for creating a new session. The partition key is NOT part of this —
 * it is fixed on the repository instance.
 */
export interface CreateSessionOptions {
  sessionId: string;
  title: string;
  agentId?: AgentId;
  storagePath?: string;
  sessionType?: SessionData['sessionType'];
  /** Cognito User Pool sub — used for AppSync channel paths (no colons). */
  channelUserId?: UserId;
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

export interface SessionsRepository {
  /** Check if a session exists (key-only projection, no payload). */
  sessionExists(sessionId: string): Promise<boolean>;

  /**
   * Create a new session. Idempotent: a duplicate `(boundPartitionKey,
   * sessionId)` is left untouched and the supplied item is returned.
   */
  createSession(options: CreateSessionOptions): Promise<SessionData>;

  /** Bump `updatedAt`. No-op (warn) if the session is gone. */
  updateSessionTimestamp(sessionId: string): Promise<void>;

  /** Get session data, or `null` when absent. */
  getSession(sessionId: string): Promise<SessionData | null>;

  /**
   * List the bound user's sessions, newest first (by `updatedAt`), with
   * opaque-token pagination. `maxResults` bounds the page size; pass the
   * returned `nextToken` back in to fetch the next page.
   */
  listSessions(maxResults?: number, nextToken?: string): Promise<SessionListResult>;

  /**
   * Update `agentId` / `storagePath` (and `updatedAt`). Only the provided fields
   * are written. No-op (warn) if the session is gone.
   */
  updateSessionAgentAndStorage(
    sessionId: string,
    agentId?: AgentId,
    storagePath?: string
  ): Promise<void>;

  /** Update session title (and `updatedAt`). No-op (warn) if the session is gone. */
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}
