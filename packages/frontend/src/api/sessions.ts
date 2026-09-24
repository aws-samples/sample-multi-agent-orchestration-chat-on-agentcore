/**
 * Session Management API Client
 * Client for calling Backend session API
 */

import { backendClient } from './client/backend-client';
import type { AgentId, SessionId } from '@moca/core';

/**
 * Session type
 */
export type SessionType = 'user' | 'event' | 'subagent';

/**
 * Session information type definition
 */
export interface SessionSummary {
  /**
   * Branded `SessionId` — AgentCore Runtime's cross-service constraint
   * (33-char alphanumeric, see `@moca/core/session-id`). Branding prevents
   * accidental interchange with `AgentId` in consumers.
   */
  sessionId: SessionId;
  title: string;
  sessionType?: SessionType;
  createdAt: string;
  updatedAt: string;
  /** Agent associated with this session, branded to match other layers. */
  agentId?: AgentId;
  storagePath?: string;
}

/**
 * ToolUse type definition (shared with Backend)
 */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status?: 'pending' | 'running' | 'completed' | 'error';
  originalToolUseId?: string;
}

/**
 * ToolResult type definition (shared with Backend)
 */
export interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * MessageContent type definition (Union type)
 */
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'toolUse'; toolUse: ToolUse }
  | { type: 'toolResult'; toolResult: ToolResult }
  | { type: 'image'; image: { base64: string; mimeType: string; fileName?: string } };

/**
 * Conversation message type definition
 */
export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant';
  contents: MessageContent[];
  timestamp: string;
}

/**
 * API response type definition
 */
interface SessionsResponse {
  sessions: SessionSummary[];
  // Pagination lives at the top level of the payload (consistent with the
  // other paginated endpoints); `metadata` carries only correlation/counters.
  nextToken?: string;
  hasMore: boolean;
  metadata: {
    requestId: string;
    timestamp: string;
    actorId: string;
    count: number;
  };
}

/**
 * Paginated session events response from the backend.
 *
 * `nextCursor` is an opaque token; callers must not interpret its contents.
 * Pass it back verbatim as `cursor` in the next request. Absent when there
 * are no further pages.
 */
interface SessionEventsPageResponse {
  events: ConversationMessage[];
  nextCursor?: string;
  hasMore: boolean;
  metadata: {
    requestId: string;
    timestamp: string;
    actorId: string;
    sessionId: string;
    count: number;
  };
}

/**
 * Options for fetching sessions
 */
export interface FetchSessionsOptions {
  limit?: number;
  nextToken?: string;
}

/**
 * Result of fetching sessions with pagination info
 */
export interface FetchSessionsResult {
  sessions: SessionSummary[];
  nextToken?: string;
  hasMore: boolean;
}

/**
 * Options for fetching session events (paginated).
 */
export interface FetchSessionEventsOptions {
  limit?: number;
  /** Opaque cursor from a previous `fetchSessionEventsPage` response. */
  cursor?: string;
}

/**
 * Result of a single paginated fetch of session events.
 */
export interface FetchSessionEventsResult {
  events: ConversationMessage[];
  /** Opaque cursor to pass for the next page. Absent when there are no more pages. */
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Fetch session list with pagination support
 * @param options Pagination options
 * @returns Sessions and pagination info
 */
export async function fetchSessions(options?: FetchSessionsOptions): Promise<FetchSessionsResult> {
  const params = new URLSearchParams();

  if (options?.limit) {
    params.set('limit', options.limit.toString());
  }

  if (options?.nextToken) {
    params.set('nextToken', options.nextToken);
  }

  const queryString = params.toString();
  const url = queryString ? `/sessions?${queryString}` : '/sessions';

  const data = await backendClient.get<SessionsResponse>(url);

  return {
    sessions: data.sessions,
    nextToken: data.nextToken,
    hasMore: data.hasMore,
  };
}

/**
 * Fetch a single page of session conversation history.
 *
 * Replaces the old `fetchSessionEvents` (which fetched all events at once and
 * could exceed the ~6 MiB Lambda response limit for long sessions).
 *
 * @param sessionId - Session to query
 * @param options   - Optional pagination parameters
 * @returns One page of events plus a cursor for the next page (if any)
 */
export async function fetchSessionEventsPage(
  sessionId: string,
  options?: FetchSessionEventsOptions
): Promise<FetchSessionEventsResult> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options?.cursor) {
    params.set('cursor', options.cursor);
  }
  const qs = params.toString();
  const url = qs ? `/sessions/${sessionId}/events?${qs}` : `/sessions/${sessionId}/events`;

  const data = await backendClient.get<SessionEventsPageResponse>(url);

  return {
    events: data.events,
    nextCursor: data.nextCursor,
    hasMore: data.hasMore,
  };
}

/**
 * Delete a session
 * @param sessionId Session ID to delete
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await backendClient.delete(`/sessions/${sessionId}`);
}
