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

interface SessionEventsResponse {
  events: ConversationMessage[];
  metadata: {
    requestId: string;
    timestamp: string;
    actorId: string;
    sessionId: SessionId;
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
 * Fetch session conversation history
 * @param sessionId Session ID
 * @returns Conversation history
 */
export async function fetchSessionEvents(sessionId: string): Promise<ConversationMessage[]> {
  const data = await backendClient.get<SessionEventsResponse>(`/sessions/${sessionId}/events`);
  return data.events;
}

/**
 * Delete a session
 * @param sessionId Session ID to delete
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await backendClient.delete(`/sessions/${sessionId}`);
}
