/**
 * `SessionsRepository` — the behaviour contract for session persistence.
 *
 * THIS FILE IS THE WHOLE PUBLIC SURFACE. To *use* sessions you only need this
 * interface plus the domain types in `./types.ts`; you never need to open the
 * `./dynamodb/` implementation. Routes and services depend on this interface,
 * not on a concrete class, so the storage engine can be swapped (a second
 * implementation, an in-memory fake for unit tests) without touching callers.
 *
 * Contract notes that hold for ANY implementation:
 * - The backend is read/delete-only; sessions are created by the agent package.
 * - `userId` scopes every operation; a session is addressed by `(userId, sessionId)`.
 * - A missing session reads as `null` (get); deleting a missing session is a no-op.
 */

import type { IdentityId } from '@moca/core';
import type { SessionData, SessionSummary } from './types.js';

// --- Method output types -----------------------------------------------------
// Describes how you OPERATE on sessions (the return shape of a list), as
// opposed to the domain MODEL in `./types.ts`. It lives here because it only
// makes sense paired with `listSessions`.

/**
 * Session list result with pagination
 */
export interface SessionListResult {
  sessions: SessionSummary[];
  nextToken?: string;
  hasMore: boolean;
}

export interface SessionsRepository {
  /**
   * Whether the repository is wired to a backing store. Routes call this to
   * short-circuit with a CONFIGURATION_ERROR (or skip optional work) before
   * invoking the data methods, so the methods themselves assume a configured
   * store.
   */
  isConfigured(): boolean;

  /**
   * List a user's sessions, newest first (by `updatedAt`), with opaque-key
   * pagination. `maxResults` bounds the page size.
   */
  listSessions(
    userId: IdentityId,
    maxResults?: number,
    exclusiveStartKey?: Record<string, unknown>
  ): Promise<SessionListResult>;

  /** Get a single session, or `null` if the user has no such session. */
  getSession(userId: IdentityId, sessionId: string): Promise<SessionData | null>;

  /** Delete a session. Deleting a missing session is a no-op (idempotent). */
  deleteSession(userId: IdentityId, sessionId: string): Promise<void>;
}
