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
  paginateListEvents,
  ListEventsCommand,
  type Event as AgentCoreEvent,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config/index.js';
import { createAgentCoreClient } from '../libs/auth/scoped-credentials.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createLogger } from '../libs/logger/index.js';
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
import {
  EVENTS_DEFAULT_PAGE_SIZE,
  EVENTS_MAX_PAGE_SIZE,
  PAGE_BYTE_BUDGET_BYTES,
  BLOCK_TRUNCATE_THRESHOLD_BYTES,
  type EventPageCursor,
  encodeEventCursor,
} from '../libs/http/index.js';

const log = createLogger('AgentCoreMemoryService');

// Re-export the decoding/mapping surface so existing importers
// (`../agentcore-memory`) keep working after the split.
export {
  convertToMessageContents,
  parseBlobPayload,
  type MessageContent,
} from './memory/content-codec.js';
export type {
  MemoryRecord,
  MemoryRecordList,
} from './memory/record-mapper.js';

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
 * Result of a single event-history page request.
 *
 * `events` are in chronological order (oldest → newest) within the page.
 * `nextCursor` is absent when there are no older events; present when older
 * pages can be loaded by passing it back as `?cursor=<nextCursor>`.
 */
export interface SessionEventsPage {
  events: ConversationMessage[];
  nextCursor?: string;
  hasMore: boolean;
}

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
 * Replace oversized content blocks in a message with identity-preserving
 * truncation placeholders (option a).
 *
 * For blocks that carry both identity fields (id, toolUseId, name) and a heavy
 * payload field (input, content, text), the payload field is replaced with an
 * empty value and a `truncated: { field, byteSize }` marker is added to the
 * block.  This keeps tool-step pairing intact on the frontend while ensuring
 * the page stays within the byte budget.
 *
 * For block types without identity fields (text, image) the legacy generic
 * `{ type:'truncated', truncated:{ originalType, byteSize } }` shape is used
 * as a fallback (those block types are extremely unlikely to exceed the
 * threshold in practice).
 */
function applyContentTruncation(msg: ConversationMessage): ConversationMessage {
  const newContents = msg.contents.map((block) => {
    const blockBytes = Buffer.byteLength(JSON.stringify(block), 'utf8');
    if (blockBytes <= BLOCK_TRUNCATE_THRESHOLD_BYTES) return block;

    const marker = { field: '', byteSize: blockBytes };

    if (block.type === 'toolUse' && block.toolUse) {
      marker.field = 'input';
      return {
        type: 'toolUse' as const,
        toolUse: {
          id: block.toolUse.id,
          name: block.toolUse.name,
          input: {} as Record<string, unknown>,
          status: block.toolUse.status,
          originalToolUseId: block.toolUse.originalToolUseId,
        },
        truncated: marker,
      };
    }

    if (block.type === 'toolResult' && block.toolResult) {
      marker.field = 'content';
      return {
        type: 'toolResult' as const,
        toolResult: {
          toolUseId: block.toolResult.toolUseId,
          content: '',
          isError: block.toolResult.isError,
        },
        truncated: marker,
      };
    }

    if (block.type === 'reasoning' && block.reasoning) {
      marker.field = 'text';
      return {
        type: 'reasoning' as const,
        reasoning: { text: '' },
        truncated: marker,
      };
    }

    // Fallback for text / image / unknown types — these rarely exceed the
    // threshold but the generic placeholder keeps the page safe.
    return {
      type: 'truncated' as const,
      truncated: { originalType: block.type, byteSize: blockBytes },
    };
  });
  return { ...msg, contents: newContents };
}

/**
 * Wall-clock budget for deleting one session's events. The backend Lambda and
 * the HTTP API integration both stop at 30 s; past that the request is killed
 * mid-loop and neither the error nor the leftover count is reported. 15 s
 * leaves room for cold start, credential exchange, ListEvents, the in-flight
 * delete and the DynamoDB delete: with 20 s a live request took 27.4 s end to
 * end. Throttling is
 * absorbed by the client's adaptive retry mode (see `createAgentCoreClient`),
 * not by a second retry loop here.
 */
export const DELETE_SESSION_DEADLINE_MS = 15_000;

const isNotFound = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === 'ResourceNotFoundException';

/** Thrown when some session events are still present after the delete pass. */
export class SessionEventsDeleteError extends Error {
  constructor(
    readonly remainingEvents: number,
    readonly totalEvents: number,
    readonly reason: 'deadline' | 'errors'
  ) {
    super(
      `${remainingEvents} of ${totalEvents} session events were not deleted (${reason === 'deadline' ? 'time budget exceeded' : 'delete errors'})`
    );
    this.name = 'SessionEventsDeleteError';
  }
}

export interface AgentCoreMemoryServiceOptions {
  /** Injected for tests so the delete deadline can be simulated. */
  now?: () => number;
  deleteDeadlineMs?: number;
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
  private now: () => number;
  private deleteDeadlineMs: number;

  constructor(
    memoryId: string,
    client: BedrockAgentCoreClient,
    options: AgentCoreMemoryServiceOptions = {}
  ) {
    this.client = client;
    this.memoryId = memoryId;
    this.now = options.now ?? Date.now;
    this.deleteDeadlineMs = options.deleteDeadlineMs ?? DELETE_SESSION_DEADLINE_MS;
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
   * Delete a session from AgentCore Memory by deleting all events.
   *
   * Idempotent: an actor/session/event that no longer exists counts as
   * deleted, so a retry after a partial failure converges to success.
   *
   * @throws SessionEventsDeleteError if any event is left — either a delete
   *   failed (after the client's adaptive retries) or the time budget ran out.
   *   Callers must not treat the session as gone in that case.
   */
  async deleteSession(actorId: string, sessionId: string): Promise<void> {
    const deadline = this.now() + this.deleteDeadlineMs;
    try {
      log.info(`Deleting session events: sessionId=${sessionId}`);

      const eventIds: string[] = [];
      try {
        const paginator = paginateListEvents(
          { client: this.client },
          { memoryId: this.memoryId, actorId, sessionId, maxResults: 100 }
        );
        for await (const page of paginator) {
          for (const event of page.events ?? []) {
            if (event.eventId) eventIds.push(event.eventId);
          }
        }
      } catch (error) {
        // Same case listSessions handles for new users: nothing to delete.
        if (!isNotFound(error)) throw error;
      }

      log.info(`Found ${eventIds.length} events to delete`);

      // Sequential on purpose: parallel deletes only make throttling worse.
      let failed = 0;
      let index = 0;
      for (; index < eventIds.length; index++) {
        if (this.now() >= deadline) break;
        try {
          await this.client.send(
            new DeleteEventCommand({
              memoryId: this.memoryId,
              actorId,
              sessionId,
              eventId: eventIds[index],
            })
          );
        } catch (error) {
          if (!isNotFound(error)) {
            failed++;
            log.warn({ err: error, eventId: eventIds[index] }, 'Failed to delete event');
          }
        }
      }

      const notAttempted = eventIds.length - index;
      if (failed > 0 || notAttempted > 0) {
        throw new SessionEventsDeleteError(
          failed + notAttempted,
          eventIds.length,
          notAttempted > 0 ? 'deadline' : 'errors'
        );
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
   * Get a single size-bounded page of conversation history.
   *
   * ASSUMPTION: `ListEvents` returns events newest → oldest across upstream
   * pages. The first upstream page (no nextToken) therefore contains the most
   * recent events. This assumption is documented here and pinned by the test
   * suite rather than trusted silently.
   *
   * When `cursor` is absent the most recent page is returned; subsequent calls
   * with the returned `nextCursor` navigate backward through time. Events
   * within each page are returned chronologically (oldest → newest).
   *
   * Two independent page bounds, whichever is hit first:
   *   1. `limit` — maximum message count (default {@link EVENTS_DEFAULT_PAGE_SIZE},
   *      max {@link EVENTS_MAX_PAGE_SIZE}).
   *   2. {@link PAGE_BYTE_BUDGET_BYTES} — serialized byte budget for the events
   *      array. Content blocks that individually exceed
   *      {@link BLOCK_TRUNCATE_THRESHOLD_BYTES} are always replaced with
   *      truncation placeholders before the budget check, so a single message
   *      with large toolUse/toolResult/reasoning content stays within budget.
   *
   * @param actorId  Cognito Identity ID of the caller.
   * @param sessionId  AgentCore session ID.
   * @param opts.limit  Requested page size (clamped to max).
   * @param opts.cursor  Decoded cursor from a previous call; absent = first page.
   */
  async getSessionEventsPage(
    actorId: string,
    sessionId: string,
    opts: { limit?: number; cursor?: EventPageCursor } = {}
  ): Promise<SessionEventsPage> {
    const limit = Math.min(
      Math.max(1, opts.limit ?? EVENTS_DEFAULT_PAGE_SIZE),
      EVENTS_MAX_PAGE_SIZE
    );
    const cursor = opts.cursor;

    log.info(
      { sessionId, limit, hasCursor: !!cursor, offset: cursor?.off ?? 0 },
      'Event history page request'
    );

    const pageMessages: ConversationMessage[] = [];
    let runningBytes = 0;
    let budgetLimited = false;
    let upstreamPageCount = 0;

    // Token that was PASSED to the most recent ListEvents call (undefined = first upstream page).
    let currentPageToken: string | undefined = cursor?.tok;
    // How many events to skip from the current upstream page (already served to client).
    let currentSkipCount = cursor?.off ?? 0;
    // nextToken returned by the most recent ListEvents call (for the next upstream page).
    let lastResponseNextToken: string | undefined = undefined;
    // Cursor to emit when we stop mid-upstream-page.
    let resultNextCursor: EventPageCursor | undefined;

    // Iterate upstream pages (each iteration = one ListEvents call).
    // ListEvents returns events newest → oldest, so we navigate from newest backward.
    while (pageMessages.length < limit) {
      const response = await this.client.send(
        new ListEventsCommand({
          memoryId: this.memoryId,
          actorId,
          sessionId,
          includePayloads: true,
          maxResults: 100,
          nextToken: currentPageToken,
        })
      );
      upstreamPageCount++;

      const upstreamEvents = response.events ?? [];
      lastResponseNextToken = response.nextToken;

      if (upstreamEvents.length === 0) {
        break;
      }

      // Apply in-page offset: skip events already served from this upstream page.
      const initialSkip = currentSkipCount;
      const eventsToProcess = upstreamEvents.slice(initialSkip);
      currentSkipCount = 0; // reset for any subsequent upstream pages

      for (let i = 0; i < eventsToProcess.length; i++) {
        // Limit check: stop collecting and emit a cursor before adding.
        if (pageMessages.length >= limit) {
          resultNextCursor = {
            v: 1,
            sid: sessionId,
            tok: currentPageToken,
            off: initialSkip + i,
          };
          break;
        }

        const event = eventsToProcess[i];
        const raw = this._convertEventToMessage(event);
        if (!raw) continue;

        // Always truncate oversized content blocks first, so the byte check
        // operates on the post-truncation size.
        const msg = applyContentTruncation(raw);
        const msgBytes = Buffer.byteLength(JSON.stringify(msg), 'utf8');

        if (runningBytes + msgBytes > PAGE_BYTE_BUDGET_BYTES) {
          if (pageMessages.length === 0) {
            // Even after truncation this single message exceeds the budget
            // (extreme edge case). Include it anyway so the page is non-empty.
            pageMessages.push(msg);
            runningBytes += msgBytes;
            budgetLimited = true;
            resultNextCursor = {
              v: 1,
              sid: sessionId,
              tok: currentPageToken,
              off: initialSkip + i + 1,
            };
          } else {
            budgetLimited = true;
            resultNextCursor = {
              v: 1,
              sid: sessionId,
              tok: currentPageToken,
              off: initialSkip + i,
            };
          }
          break;
        }

        pageMessages.push(msg);
        runningBytes += msgBytes;
      }

      if (resultNextCursor) break; // stopped mid-page

      if (!lastResponseNextToken) break; // no more upstream pages

      // Advance to the next (older) upstream page.
      currentPageToken = lastResponseNextToken;
    }

    // Build the output cursor. `resultNextCursor` covers mid-page stops.
    // `lastResponseNextToken` covers the case where we exhausted a page
    // without hitting limits but more upstream pages remain.
    let outputCursor: string | undefined;
    if (resultNextCursor) {
      outputCursor = encodeEventCursor(resultNextCursor);
    } else if (lastResponseNextToken) {
      outputCursor = encodeEventCursor({
        v: 1,
        sid: sessionId,
        tok: lastResponseNextToken,
        off: 0,
      });
    }

    // Reverse: events were collected newest → oldest; return oldest → newest.
    pageMessages.reverse();

    log.info(
      {
        sessionId,
        upstreamPageCount,
        messageCount: pageMessages.length,
        serializedBytes: runningBytes,
        budgetLimited,
        hasMore: !!outputCursor,
      },
      'Event history page served'
    );

    return {
      events: pageMessages,
      nextCursor: outputCursor,
      hasMore: !!outputCursor,
    };
  }

  /**
   * Convert a raw ListEvents event record to a {@link ConversationMessage}.
   * Returns null if the event has no usable payload.
   */
  private _convertEventToMessage(event: AgentCoreEvent): ConversationMessage | null {
    if (!event.payload || event.payload.length === 0) return null;

    // Cast to a looser type so we can use `in` checks — the SDK's `PayloadType`
    // discriminated union is structurally correct but doesn't expose an index
    // signature, so we cast through `unknown` to avoid false TS errors.
    const payloadItems = event.payload as unknown as Array<Record<string, unknown>>;

    for (const payloadItem of payloadItems) {
      if ('conversational' in payloadItem) {
        const cp = payloadItem as {
          conversational: { role: string; content: { text: string } };
        };
        const role = cp.conversational.role;
        const text = cp.conversational.content.text;
        return {
          id: event.eventId || `event_${Date.now()}`,
          type: role === 'USER' ? 'user' : 'assistant',
          contents: [{ type: 'text', text }],
          timestamp: event.eventTimestamp?.toISOString() || new Date().toISOString(),
        };
      }

      if ('blob' in payloadItem && payloadItem['blob']) {
        const blobData = parseBlobPayload(payloadItem['blob']);
        if (blobData) {
          const messageContents = convertToMessageContents(blobData.content);
          return {
            id: event.eventId || `event_${Date.now()}`,
            type: blobData.role === 'user' ? 'user' : 'assistant',
            contents: messageContents,
            timestamp: event.eventTimestamp?.toISOString() || new Date().toISOString(),
          };
        }
      }
    }

    return null;
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
      const summaries = (response as typeof response & {
        memoryRecordSummaries?: MemoryRecordSummary[];
      }).memoryRecordSummaries;

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
      const summaries = (response as typeof response & {
        memoryRecordSummaries?: MemoryRecordSummary[];
      }).memoryRecordSummaries;

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
