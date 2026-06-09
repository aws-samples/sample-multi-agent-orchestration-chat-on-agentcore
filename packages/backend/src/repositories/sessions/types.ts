/**
 * Session domain MODEL — what a session *is*, independent of how you operate on
 * it. These are the types you reach for to read or hold a session value.
 *
 * The repository's method output types (e.g. `SessionListResult`) live with the
 * `SessionsRepository` interface in `./sessions-repository.ts`, not here: they
 * only make sense alongside the method they describe, so co-locating them keeps
 * this file to the data model.
 *
 * The backend only reads/deletes sessions; rows are written by the agent
 * package's SessionsService. These types describe the DOMAIN only — no DynamoDB
 * storage details leak in (key marshalling lives in `./dynamodb/item.ts`).
 */

import type { AgentId, IdentityId } from '@moca/core';

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
