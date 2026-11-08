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
  /** ISO start of the turn running server-side; absent when idle. */
  activeTurnStartedAt?: string;
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
  | { type: 'image'; image: { base64: string; mimeType: string; fileName?: string } }
  | { type: 'truncated'; truncated: { originalType: string; byteSize: number } };

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

interface SessionEventsResponse {
  events: ConversationMessage[];
  nextCursor?: string;
  hasMore: boolean;
  metadata: {
    requestId: string;
    timestamp: string;
    actorId: string;
    sessionId: SessionId;
    count: number;
  };
}

/**
 * Result of fetching a single events page.
 */
export interface FetchSessionEventsResult {
  events: ConversationMessage[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Options for fetching session events.
 */
export interface FetchSessionEventsOptions {
  /** Opaque cursor from a previous response; absent = first (latest) page. */
  cursor?: string;
  /** Requested page size. */
  limit?: number;
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
 * Fetch a page of session conversation history.
 *
 * When called without options (no `cursor`) the most recent page is returned.
 * Older pages are fetched by passing the `nextCursor` from a previous response.
 *
 * Old clients that call without parameters receive the latest page only
 * (recent history) rather than an HTTP 500, preserving backward compatibility.
 *
 * @param sessionId Session ID
 * @param options   Pagination options
 * @returns Events page with pagination cursors
 */
export async function fetchSessionEvents(
  sessionId: string,
  options?: FetchSessionEventsOptions
): Promise<FetchSessionEventsResult> {
  const params = new URLSearchParams();

  if (options?.cursor) {
    params.set('cursor', options.cursor);
  }

  if (options?.limit) {
    params.set('limit', options.limit.toString());
  }

  const queryString = params.toString();
  const url = queryString
    ? `/sessions/${sessionId}/events?${queryString}`
    : `/sessions/${sessionId}/events`;

  const data = await backendClient.get<SessionEventsResponse>(url);

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
