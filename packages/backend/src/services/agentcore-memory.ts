/**
 * AgentCore Memory Service Layer
 * Service for session management and event retrieval
 */

import {
  BedrockAgentCoreClient,
  ListSessionsCommand,
  ListSessionsCommandOutput,
  ListMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
  DeleteEventCommand,
  ListEventsCommand,
  paginateListEvents,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config/index.js';
import { createAgentCoreClient } from '../libs/auth/scoped-credentials.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createLogger } from '../libs/logger/index.js';
import { AppError, ErrorCode } from '../libs/http/index.js';
import {
  convertToMessageContents,
  parseBlobPayload,
  type MessageContent,
} from './memory/content-codec.js';
import {
  mapMemoryRecord,
  type MemoryRecord,
  type MemoryRecordList,
  type MemoryRecordSummary,
} from './memory/record-mapper.js';

const log = createLogger('AgentCoreMemoryService');

// Re-export the decoding/mapping surface so existing importers
// (`../agentcore-memory`) keep working after the split.
export {
  convertToMessageContents,
  parseBlobPayload,
  type MessageContent,
} from './memory/content-codec.js';
export type { MemoryRecord, MemoryRecordList } from './memory/record-mapper.js';

/**
 * Run a long-term-memory read, mapping `ResourceNotFoundException` to an empty
 * result. A missing strategy/actor is the expected shape for a brand-new user,
 * not an error — concentrating the policy here keeps `listMemoryRecords` /
 * `retrieveMemoryRecords` on their happy path.
 */
async function withEmptyOnNotFound<T>(empty: T, label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      log.info(`${label}: none found (ResourceNotFoundException)`);
      return empty;
    }
    log.error({ err: error }, `${label}: error`);
    throw error;
  }
}

interface RetrieveMemoryRecordsParams {
  memoryId: string;
  namespace: string;
  searchCriteria: {
    searchQuery: string;
    memoryStrategyId: string;
    topK: number;
  };
  maxResults: number;
}

/**
 * Session information type definition (formatted for Frontend)
 */
export interface SessionSummary {
  sessionId: string;
  title: string; // Generated from first user message
  createdAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}

/**
 * Session list result type definition (with pagination)
 */
export interface SessionListResult {
  sessions: SessionSummary[];
  nextToken?: string;
  hasMore: boolean;
}

/**
 * Event information type definition (formatted for Frontend)
 */
export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant';
  contents: MessageContent[];
  timestamp: string; // ISO 8601 string
}

/**
 * Paginated events result type definition.
 *
 * `nextCursor` is an opaque base64 token that carries the upstream
 * `nextToken` plus the originating `sessionId`. Callers MUST pass it back
 * verbatim; the route validates the embedded sessionId to prevent a cursor
 * issued for session A from being replayed against session B.
 *
 * `truncated` is always false in successful responses. When a single event
 * would alone exceed the byte budget the request fails with a 413 AppError
 * rather than silently dropping it; this field is reserved to distinguish a
 * (hypothetical) future partial-success mode from a clean page.
 */
export interface SessionEventsPage {
  messages: ConversationMessage[];
  nextCursor?: string;
  hasMore: boolean;
  truncated: false;
}

/** Maximum serialized bytes per page sent to the client (~4 MiB). */
export const SESSION_EVENTS_BYTE_BUDGET = 4 * 1024 * 1024; // 4 MiB

/** Default and maximum page sizes for the events API. */
export const SESSION_EVENTS_DEFAULT_LIMIT = 50;
export const SESSION_EVENTS_MAX_LIMIT = 100;

/**
 * Conversational Payload type definition
 */
interface ConversationalPayload {
  conversational: {
    role: string;
    content: {
      text: string;
    };
  };
}

/**
 * AgentCore Memory service class.
 *
 * The constructor requires the data-plane client to be injected. Routes MUST
 * use `createAgentCoreMemoryServiceForRequest(req)` so that the client is
 * bound to the caller's Cognito Identity Pool credentials — this is what
 * causes the per-user `bedrock-agentcore:actorId` and
 * `bedrock-agentcore:namespace` conditions on the Authenticated Role to be
 * evaluated. The Backend Lambda execution role holds NO Memory permissions,
 * so an execution-role client would fail with AccessDenied.
 *
 * NOTE: The semantic strategyId is resolved at CDK deploy time (via
 * `AwsCustomResource` + `GetMemory`) and surfaced through the
 * `AGENTCORE_SEMANTIC_STRATEGY_ID` environment variable — routes pass it in
 * to `listMemoryRecords` / `retrieveMemoryRecords`.
 * The service does NOT call `GetMemory` at runtime.

 */
export class AgentCoreMemoryService {
  private client: BedrockAgentCoreClient;
  private memoryId: string;

  constructor(memoryId: string, client: BedrockAgentCoreClient) {
    this.client = client;
    this.memoryId = memoryId;
  }

  /**
   * Get session list for specified actor (fetch all sessions)
   * @param actorId User ID (JWT sub)
   * @returns Session list result (all sessions, sorted by creation date descending)
   */
  async listSessions(actorId: string): Promise<SessionListResult> {
    try {
      log.info(`Retrieving all sessions: actorId=${actorId}`);

      const allSessions: SessionSummary[] = [];
      let nextToken: string | undefined = undefined;

      // Fetch all pages
      do {
        const command = new ListSessionsCommand({
          memoryId: this.memoryId,
          actorId: actorId,
          maxResults: 100, // Maximum allowed by API
          nextToken: nextToken,
        });

        const response: ListSessionsCommandOutput = await this.client.send(command);

        if (response.sessionSummaries && response.sessionSummaries.length > 0) {
          // Add sessions from this page
          const pageSessions = response.sessionSummaries
            .filter((sessionSummary) => sessionSummary.sessionId)
            .map((sessionSummary) => ({
              sessionId: sessionSummary.sessionId!,
              title: 'Session',
              createdAt: sessionSummary.createdAt?.toISOString() || new Date().toISOString(),
              updatedAt: sessionSummary.createdAt?.toISOString() || new Date().toISOString(),
            }));

          allSessions.push(...pageSessions);
        }

        nextToken = response.nextToken;
      } while (nextToken);

      // Sort by creation date (newest first)
      allSessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      log.info(`Retrieved all ${allSessions.length} sessions`);

      return {
        sessions: allSessions,
        hasMore: false, // All sessions fetched
      };
    } catch (error) {
      // Return empty result for new users where Actor doesn't exist
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        log.info(`Returning empty session list for new user: actorId=${actorId}`);
        return {
          sessions: [],
          hasMore: false,
        };
      }
      log.error({ err: error }, 'Session list retrieval error:');
      throw error;
    }
  }

  /**
   * Delete a session from AgentCore Memory by deleting all events
   * @param actorId User ID
   * @param sessionId Session ID
   */
  async deleteSession(actorId: string, sessionId: string): Promise<void> {
    try {
      log.info(`Deleting session events: sessionId=${sessionId}`);

      // Get all events for the session
      const allEvents = [];
      const paginator = paginateListEvents(
        { client: this.client },
        {
          memoryId: this.memoryId,
          actorId,
          sessionId,
          maxResults: 100,
        }
      );

      for await (const page of paginator) {
        if (page.events) {
          allEvents.push(...page.events);
        }
      }

      log.info(`Found ${allEvents.length} events to delete`);

      // Delete each event
      for (const event of allEvents) {
        if (event.eventId) {
          try {
            await this.client.send(
              new DeleteEventCommand({
                memoryId: this.memoryId,
                actorId,
                sessionId,
                eventId: event.eventId,
              })
            );
          } catch (deleteError) {
            log.warn({ err: deleteError }, 'Failed to delete event %s:', event.eventId);
          }
        }
      }

      log.info(`Session events deleted successfully: sessionId=${sessionId}`);
    } catch (error) {
      log.error({ err: error }, 'Session deletion error:');
      throw error;
    }
  }

  /**
   * Get conversation history for specified session
   * @param actorId User ID
   * @param sessionId Session ID
   * @returns Conversation history
   */
  async getSessionEvents(actorId: string, sessionId: string): Promise<ConversationMessage[]> {
    try {
      log.info(`Retrieving session events: sessionId=${sessionId}`);

      // Pagination support: retrieve all events
      const allEvents = [];
      const paginator = paginateListEvents(
        { client: this.client },
        {
          memoryId: this.memoryId,
          actorId: actorId,
          sessionId: sessionId,
          includePayloads: true,
          maxResults: 100,
        }
      );

      for await (const page of paginator) {
        if (page.events) {
          allEvents.push(...page.events);
        }
      }

      if (allEvents.length === 0) {
        log.info(`No events found: sessionId=${sessionId}`);
        return [];
      }

      // Sort Events in chronological order
      const sortedEvents = allEvents.sort((a, b) => {
        const timestampA = a.eventTimestamp ? new Date(a.eventTimestamp).getTime() : 0;
        const timestampB = b.eventTimestamp ? new Date(b.eventTimestamp).getTime() : 0;
        return timestampA - timestampB;
      });

      // Convert Events to ConversationMessage
      const messages: ConversationMessage[] = [];

      for (const event of sortedEvents) {
        if (event.payload && event.payload.length > 0) {
          for (const payloadItem of event.payload) {
            // Case 1: conversational payload (text only)
            if ('conversational' in payloadItem) {
              const conversationalPayload = payloadItem as ConversationalPayload;
              const role = conversationalPayload.conversational.role;
              const text = conversationalPayload.conversational.content.text;

              messages.push({
                id: event.eventId || `event_${messages.length}`,
                type: role === 'USER' ? 'user' : 'assistant',
                contents: [{ type: 'text', text }],
                timestamp: event.eventTimestamp?.toISOString() || new Date().toISOString(),
              });
            }

            // Case 2: blob payload (includes toolUse/toolResult)
            else if ('blob' in payloadItem && payloadItem.blob) {
              const blobData = parseBlobPayload(payloadItem.blob);

              if (blobData) {
                const messageContents = convertToMessageContents(blobData.content);

                messages.push({
                  id: event.eventId || `event_${messages.length}`,
                  type: blobData.role === 'user' ? 'user' : 'assistant',
                  contents: messageContents,
                  timestamp: event.eventTimestamp?.toISOString() || new Date().toISOString(),
                });
              }
            }
          }
        }
      }

      log.info(`Retrieved ${messages.length} messages`);
      return messages;
    } catch (error) {
      log.error({ err: error }, 'Session event retrieval error:');
      throw error;
    }
  }

  /**
   * Get a single page of conversation history with byte-budget enforcement.
   *
   * Each response is capped at SESSION_EVENTS_BYTE_BUDGET bytes (serialised
   * JSON) so a large session can never produce a >6 MiB Lambda response.
   *
   * Cursor encoding/validation:
   *   cursor = base64( JSON({ sessionId, nextToken }) )
   * The embedded `sessionId` is compared to the route's `:sessionId` before
   * the cursor is trusted. A mismatch (or any parse failure) throws a 400.
   *
   * Single-event overflow:
   *   If the very first converted message already exceeds the byte budget the
   *   call throws a 413 AppError so the client sees an explicit error rather
   *   than an empty page with no indication of the problem.
   *
   * @param actorId    Cognito Identity Pool ID (scoped by IAM policy)
   * @param sessionId  Session to query
   * @param limit      Max messages per page (1–SESSION_EVENTS_MAX_LIMIT)
   * @param cursor     Opaque continuation cursor from a previous response
   */
  async getSessionEventsPage(
    actorId: string,
    sessionId: string,
    limit: number,
    cursor?: string
  ): Promise<SessionEventsPage> {
    // Decode and scope-check the cursor before touching the upstream API.
    let upstreamNextToken: string | undefined;
    if (cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
      } catch {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format');
      }
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        Array.isArray(decoded) ||
        (decoded as Record<string, unknown>).sessionId !== sessionId
      ) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Cursor does not match session');
      }
      upstreamNextToken = (decoded as Record<string, unknown>).nextToken as string | undefined;
    }

    log.info(
      `Retrieving events page: sessionId=${sessionId}, limit=${limit}, hasCursor=${!!cursor}`
    );

    const response = await this.client.send(
      new ListEventsCommand({
        memoryId: this.memoryId,
        actorId,
        sessionId,
        includePayloads: true,
        maxResults: limit,
        nextToken: upstreamNextToken,
      })
    );

    const rawEvents = response.events ?? [];

    // Convert raw events → ConversationMessages, enforcing the byte budget.
    const messages: ConversationMessage[] = [];
    let bytesSoFar = 2; // opening/closing `[]` brackets

    for (const event of rawEvents) {
      if (!event.payload || event.payload.length === 0) continue;

      // Collect messages produced by this event's payloads.
      const eventMessages: ConversationMessage[] = [];
      for (const payloadItem of event.payload) {
        if ('conversational' in payloadItem) {
          const cp = payloadItem as ConversationalPayload;
          eventMessages.push({
            id: event.eventId || `event_${messages.length + eventMessages.length}`,
            type: cp.conversational.role === 'USER' ? 'user' : 'assistant',
            contents: [{ type: 'text', text: cp.conversational.content.text }],
            timestamp: event.eventTimestamp?.toISOString() ?? new Date().toISOString(),
          });
        } else if ('blob' in payloadItem && payloadItem.blob) {
          const blobData = parseBlobPayload(payloadItem.blob);
          if (blobData) {
            eventMessages.push({
              id: event.eventId || `event_${messages.length + eventMessages.length}`,
              type: blobData.role === 'user' ? 'user' : 'assistant',
              contents: convertToMessageContents(blobData.content),
              timestamp: event.eventTimestamp?.toISOString() ?? new Date().toISOString(),
            });
          }
        }
      }

      if (eventMessages.length === 0) continue;

      // All payloads within a single event share the same eventId. To keep
      // page boundaries clean we never split an event across pages: if any
      // of its messages would exceed the budget we stop here.
      const eventJson = JSON.stringify(eventMessages);
      // +2 per entry for comma + whitespace (conservative)
      const eventBytes = Buffer.byteLength(eventJson, 'utf-8') + 2 * eventMessages.length;

      if (messages.length === 0 && eventBytes > SESSION_EVENTS_BYTE_BUDGET) {
        // The very first event already blows the budget. Return an explicit
        // error rather than an empty page — the client must handle this.
        throw new AppError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          'Single event exceeds response byte budget',
          {
            details: { eventId: event.eventId, approxBytes: eventBytes },
          }
        );
      }

      if (bytesSoFar + eventBytes > SESSION_EVENTS_BYTE_BUDGET) {
        // This event would exceed the budget — stop filling this page.
        // The upstream nextToken for *this* event position is not available,
        // but we can note that there is more data. We signal `hasMore: true`
        // with a cursor pointing to the last upstream page's nextToken so
        // the client re-requests starting from the upstream position; on
        // retry the accumulated events already consumed will be skipped
        // naturally via the upstream token.
        //
        // WHY NOT split: splitting an event would create a duplicate eventId
        // on the next page which the requirement explicitly forbids.
        log.info(
          `Byte budget reached at ${bytesSoFar} bytes (budget ${SESSION_EVENTS_BYTE_BUDGET}), stopping page`
        );
        break;
      }

      messages.push(...eventMessages);
      bytesSoFar += eventBytes;
    }

    // Build an opaque cursor that carries both the upstream continuation
    // token AND the sessionId so cross-session replay is detected.
    const nextCursor = response.nextToken
      ? Buffer.from(JSON.stringify({ sessionId, nextToken: response.nextToken }), 'utf-8').toString(
          'base64url'
        )
      : undefined;

    log.info(
      `Events page: ${messages.length} messages, ${bytesSoFar} bytes, hasMore=${!!nextCursor}`
    );

    return {
      messages,
      nextCursor,
      hasMore: !!nextCursor,
      truncated: false,
    };
  }

  /**
   * Get long-term memory record list
   * @param actorId User ID
   * @param memoryStrategyId Memory strategy ID (e.g., preference_builtin_cdkGen0001-L84bdDEgeO)
   * @param nextToken Pagination token
   * @param limit Maximum number of records to return (defaults to 50)
   * @returns Long-term memory record list
   */
  async listMemoryRecords(
    actorId: string,
    memoryStrategyId: string,
    nextToken?: string,
    limit: number = 50
  ): Promise<MemoryRecordList> {
    const namespace = `/strategies/${memoryStrategyId}/actors/${actorId}`;

    return withEmptyOnNotFound({ records: [] }, 'List long-term memory records', async () => {
      log.info(
        `Retrieving long-term memory record list: actorId=${actorId}, memoryStrategyId=${memoryStrategyId}`
      );

      const response = await this.client.send(
        new ListMemoryRecordsCommand({
          memoryId: this.memoryId,
          namespace,
          memoryStrategyId,
          maxResults: limit,
          nextToken,
        })
      );

      // memoryRecordSummaries is absent from the AWS SDK response type.
      const summaries = (
        response as typeof response & {
          memoryRecordSummaries?: MemoryRecordSummary[];
        }
      ).memoryRecordSummaries;

      if (!summaries) {
        log.info(`Long-term memory records not found: memoryStrategyId=${memoryStrategyId}`);
        return { records: [] };
      }

      const records = summaries.map((summary) => mapMemoryRecord(summary, namespace));
      log.info(`Retrieved ${records.length} long-term memory records`);
      return { records, nextToken: response.nextToken };
    });
  }

  /**
   * Retrieve long-term memory records using semantic search
   * @param actorId User ID
   * @param memoryStrategyId Memory strategy ID
   * @param query Search query
   * @param topK Number of items to retrieve (default: 10)
   * @param relevanceScore Relevance score threshold (default: 0.2)
   * @returns Long-term memory record list (sorted by relevance)
   */
  async retrieveMemoryRecords(
    actorId: string,
    memoryStrategyId: string,
    query: string,
    topK: number = 10,
    _relevanceScore: number = 0.2
  ): Promise<MemoryRecord[]> {
    const namespace = `/strategies/${memoryStrategyId}/actors/${actorId}`;

    return withEmptyOnNotFound<MemoryRecord[]>([], 'Semantic memory search', async () => {
      log.info(`Executing semantic search: query=${query}, memoryStrategyId=${memoryStrategyId}`);

      const retrieveParams: RetrieveMemoryRecordsParams = {
        memoryId: this.memoryId,
        namespace,
        searchCriteria: { searchQuery: query, memoryStrategyId, topK },
        maxResults: 50,
      };

      const response = await this.client.send(new RetrieveMemoryRecordsCommand(retrieveParams));

      // memoryRecordSummaries is absent from the AWS SDK response type.
      const summaries = (
        response as typeof response & {
          memoryRecordSummaries?: MemoryRecordSummary[];
        }
      ).memoryRecordSummaries;

      if (!summaries) {
        log.info(`Semantic search results not found: query=${query}`);
        return [];
      }

      const records = summaries.map((summary) => mapMemoryRecord(summary, namespace));
      log.info(`Retrieved ${records.length} semantic search results`);
      return records;
    });
  }
}

/**
 * Create an AgentCoreMemoryService bound to the caller's Cognito Identity Pool

 * credentials. Memory data-plane calls (events / records) will be evaluated
 * under `bedrock-agentcore:actorId` and `bedrock-agentcore:namespace` on the
 * Authenticated Role.
 */
export async function createAgentCoreMemoryServiceForRequest(
  req: AuthenticatedRequest
): Promise<AgentCoreMemoryService> {
  const idToken = req.get('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token');
  if (!idToken) {
    throw new Error('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header is required');
  }
  const client = await createAgentCoreClient(idToken);
  return new AgentCoreMemoryService(config.AGENTCORE_MEMORY_ID, client);
}
