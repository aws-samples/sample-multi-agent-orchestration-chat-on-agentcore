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
 * `nextCursor` is an opaque base64url token that encodes the upstream
 * continuation token, the originating `sessionId`, the page size used for
 * the upstream fetch, and optionally an intra-page offset. The sessionId is
 * validated on decode so a cursor issued for session A cannot be replayed
 * against session B (→ 400).
 *
 * Cursor schema (version 1):
 *   { v: 1, sessionId: string, pageToken?: string, offset?: number, pageSize?: number }
 *   - pageToken: the upstream nextToken supplied to the ListEvents call that
 *     produced this page (NOT the nextToken returned by it). When
 *     absent/undefined the cursor means "first page".
 *   - offset: number of events at the start of the upstream page that have
 *     already been delivered. Absent/undefined means 0. Used when the byte
 *     budget cuts mid-page — the consumer re-fetches the same page and skips
 *     the first `offset` events. This prevents events between the cut-off
 *     point and the upstream page boundary from being silently dropped.
 *   - pageSize: the maxResults value used for the ListEvents call that
 *     created this cursor. Must be used for the resume call so that the
 *     upstream page composition is identical and the `offset` index is
 *     valid. Absent for cursors created before this field was introduced
 *     (graceful degradation: client's limit is used instead).
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
 * Validated, version-1 page cursor.
 * The cursor is opaque on the wire (base64url-encoded JSON) but decoded and
 * validated server-side before any upstream API call.
 */
interface PageCursorV1 {
  v: 1;
  sessionId: string;
  /** Upstream token used to fetch the page where this cursor was created.
   *  Undefined/absent → first upstream page (no nextToken to supply). */
  pageToken?: string;
  /** Events at the start of the pageToken page that have already been
   *  delivered. Zero / absent → start from the beginning of the page. */
  offset?: number;
  /**
   * The `maxResults` value used for the ListEvents call that created this
   * cursor. Stored so that a resume call re-fetches the same upstream page
   * with an identical page composition, keeping the `offset` index valid.
   *
   * When absent (cursors created before this field was introduced), the
   * caller's `limit` parameter is used as a fallback — behaviour is
   * equivalent to the pre-pageSize implementation.
   */
  pageSize?: number;
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
   * ## Cursor encoding / validation
   *
   *   cursor = base64url( JSON({ v:1, sessionId, pageToken?, offset? }) )
   *
   * - `v` must be exactly 1.
   * - `sessionId` is compared to the route's `:sessionId`; a mismatch → 400.
   * - `pageToken` (string | undefined) is the upstream token that was
   *   supplied to the ListEvents call that produced this page (the INPUT
   *   token, not the OUTPUT token). Absent/undefined means "first page."
   * - `offset` (non-negative integer | undefined) is the number of events at
   *   the start of the re-fetched page to skip because they were already
   *   returned in a prior response. Absent/undefined → 0.
   *
   * ## Why offset?
   *
   * The upstream API has no sub-page cursor. When the byte budget is hit
   * mid-page, returning `response.nextToken` as the cursor would advance to
   * the next upstream page, permanently skipping all events from the cut-off
   * point to the end of the current page. Instead, the cursor encodes the
   * INPUT pageToken and the count of events already delivered so the next
   * call re-fetches the same upstream page and resumes from the right place.
   *
   * ## Upstream error mapping
   *
   * Known upstream 4xx (ValidationException, ResourceNotFoundException) are
   * mapped to the matching AppError code so the Lambda returns a 400/404
   * rather than a 500.
   *
   * ## Single-event overflow
   *
   * If the very first converted message already exceeds the byte budget the
   * call throws a 413 AppError so the client sees an explicit error rather
   * than an empty page with no indication of the problem.
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
    // -------------------------------------------------------------------------
    // 1. Decode and scope-check the cursor.
    // -------------------------------------------------------------------------
    let upstreamPageToken: string | undefined; // token we send TO the API
    let skipCount = 0; // events to skip at the start of this page
    let cursorPageSize: number | undefined; // upstream maxResults stored in cursor

    if (cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
      } catch {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format');
      }

      // Must be a plain object (not null, not array).
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format');
      }

      const c = decoded as Record<string, unknown>;

      // Version check.
      if (c.v !== 1) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unsupported cursor version');
      }
      // sessionId binding.
      if (c.sessionId !== sessionId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Cursor does not match session');
      }
      // pageToken must be string or absent.
      if (c.pageToken !== undefined && typeof c.pageToken !== 'string') {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid cursor: pageToken must be a string'
        );
      }
      // offset must be a non-negative safe integer or absent.
      if (c.offset !== undefined) {
        if (
          !Number.isInteger(c.offset) ||
          (c.offset as number) < 0 ||
          !Number.isSafeInteger(c.offset as number)
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            'Invalid cursor: offset must be a non-negative safe integer'
          );
        }
      }
      // pageSize must be a positive integer ≤ SESSION_EVENTS_MAX_LIMIT or absent.
      if (c.pageSize !== undefined) {
        if (
          !Number.isInteger(c.pageSize) ||
          (c.pageSize as number) < 1 ||
          (c.pageSize as number) > SESSION_EVENTS_MAX_LIMIT
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            `Invalid cursor: pageSize must be an integer between 1 and ${SESSION_EVENTS_MAX_LIMIT}`
          );
        }
      }
      // Cross-field: if both offset and pageSize are present, offset < pageSize.
      if (
        c.offset !== undefined &&
        c.pageSize !== undefined &&
        (c.offset as number) >= (c.pageSize as number)
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          'Invalid cursor: offset must be less than pageSize'
        );
      }

      upstreamPageToken = c.pageToken as string | undefined;
      skipCount = (c.offset as number | undefined) ?? 0;
      cursorPageSize = c.pageSize as number | undefined;
    }

    // When a cursor carries a stored pageSize, use it for the upstream fetch
    // so the page composition is identical to when the cursor was created and
    // the `offset` index remains valid. Fall back to the caller's `limit` for
    // cursors created before this field was introduced.
    const limitUsed = cursorPageSize ?? limit;

    log.info(
      `Retrieving events page: sessionId=${sessionId}, limit=${limit}, limitUsed=${limitUsed}, hasCursor=${!!cursor}, skip=${skipCount}`
    );

    // -------------------------------------------------------------------------
    // 2. Fetch one upstream page.
    // -------------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawEvents: any[];
    let upstreamNextToken: string | undefined;

    try {
      const response = await this.client.send(
        new ListEventsCommand({
          memoryId: this.memoryId,
          actorId,
          sessionId,
          includePayloads: true,
          maxResults: limitUsed,
          nextToken: upstreamPageToken,
        })
      );
      rawEvents = response.events ?? [];
      upstreamNextToken = response.nextToken;
    } catch (err) {
      // Map known upstream 4xx to actionable AppErrors.
      if (err instanceof Error) {
        const name = err.name;
        if (name === 'ValidationException') {
          throw new AppError(ErrorCode.VALIDATION_ERROR, err.message, { cause: err });
        }
        if (name === 'ResourceNotFoundException') {
          throw new AppError(ErrorCode.NOT_FOUND, 'Session not found in memory store', {
            cause: err,
          });
        }
      }
      throw err; // other errors bubble as-is (→ 500)
    }

    // -------------------------------------------------------------------------
    // 3. Sort events by timestamp (the upstream API order is not guaranteed).
    //    Stable sort: tie-break on eventId for determinism.
    // -------------------------------------------------------------------------
    rawEvents = [...rawEvents].sort((a, b) => {
      const tA = a.eventTimestamp ? new Date(a.eventTimestamp).getTime() : 0;
      const tB = b.eventTimestamp ? new Date(b.eventTimestamp).getTime() : 0;
      if (tA !== tB) return tA - tB;
      return (a.eventId ?? '').localeCompare(b.eventId ?? '');
    });

    // -------------------------------------------------------------------------
    // 4. Apply intra-page offset (events already delivered in a previous call).
    //    Guard: if skipCount ≥ rawEvents.length the cursor is stale (the page
    //    shrunk — e.g. events were deleted). Surface as a 400 rather than
    //    returning an empty success that looks like "no more history".
    // -------------------------------------------------------------------------
    if (skipCount > 0 && skipCount >= rawEvents.length && rawEvents.length > 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Cursor offset exceeds page size; the session may have changed — please reload'
      );
    }
    const pageEvents = skipCount > 0 ? rawEvents.slice(skipCount) : rawEvents;

    // -------------------------------------------------------------------------
    // 5. Convert events → messages, enforcing the byte budget.
    // -------------------------------------------------------------------------
    const messages: ConversationMessage[] = [];
    let bytesSoFar = 2; // opening/closing `[]` brackets
    let eventsConsumed = 0; // events from pageEvents we've added to messages

    for (const event of pageEvents) {
      if (!event.payload || event.payload.length === 0) {
        eventsConsumed++;
        continue;
      }

      // Each payload item within an event gets a stable ID that incorporates
      // its index so multi-payload events don't collide during deduplication.
      const eventMessages: ConversationMessage[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event.payload.forEach((payloadItem: any, payloadIdx: number) => {
        const stableId = `${event.eventId ?? `evt_${eventsConsumed}`}:${payloadIdx}`;
        if ('conversational' in payloadItem) {
          const cp = payloadItem as ConversationalPayload;
          eventMessages.push({
            id: stableId,
            type: cp.conversational.role === 'USER' ? 'user' : 'assistant',
            contents: [{ type: 'text', text: cp.conversational.content.text }],
            timestamp: event.eventTimestamp?.toISOString() ?? new Date().toISOString(),
          });
        } else if ('blob' in payloadItem && payloadItem.blob) {
          const blobData = parseBlobPayload(payloadItem.blob);
          if (blobData) {
            eventMessages.push({
              id: stableId,
              type: blobData.role === 'user' ? 'user' : 'assistant',
              contents: convertToMessageContents(blobData.content),
              timestamp: event.eventTimestamp?.toISOString() ?? new Date().toISOString(),
            });
          }
        }
      });

      if (eventMessages.length === 0) {
        eventsConsumed++;
        continue;
      }

      // Never split a single event across pages: check budget for ALL
      // messages from this event atomically.
      const eventJson = JSON.stringify(eventMessages);
      const eventBytes = Buffer.byteLength(eventJson, 'utf-8') + 2 * eventMessages.length;

      // 413 guard: if this would be the very FIRST message output and it
      // alone exceeds the budget, there is no way to ever deliver it — return
      // an explicit error instead of an empty page (which would create an
      // endless cursor loop if the caller kept retrying).
      //
      // Note: we check `messages.length === 0` (no messages output yet) rather
      // than `eventsConsumed === 0` (no events processed yet). Empty events
      // (no payload / unrecognised payload format) increment `eventsConsumed`
      // without producing messages; using `eventsConsumed === 0` as the guard
      // would incorrectly allow the budget break-and-cursor path when empty
      // events precede a giant event, producing an empty page with hasMore=true
      // and an infinite continuation cursor.
      if (messages.length === 0 && eventBytes > SESSION_EVENTS_BYTE_BUDGET) {
        // First meaningful event on this page exceeds budget → explicit error.
        throw new AppError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          'Single event exceeds response byte budget',
          {
            details: { eventId: event.eventId, approxBytes: eventBytes },
          }
        );
      }

      if (bytesSoFar + eventBytes > SESSION_EVENTS_BYTE_BUDGET) {
        // Budget hit mid-page. Create an intra-page cursor so the next call
        // re-fetches this SAME upstream page and skips the events we already
        // returned. `upstreamPageToken` is the INPUT token we used for this
        // call (not `upstreamNextToken` which is the OUTPUT token pointing to
        // a different page).
        const newSkip = skipCount + eventsConsumed;
        const nextCursor = Buffer.from(
          JSON.stringify({
            v: 1,
            sessionId,
            pageToken: upstreamPageToken, // re-fetch THIS page
            offset: newSkip,
            pageSize: limitUsed, // store page size so resume uses same maxResults
          } satisfies PageCursorV1),
          'utf-8'
        ).toString('base64url');

        log.info(
          `Byte budget reached at ${bytesSoFar} bytes; mid-page cursor at offset ${newSkip} (pageSize=${limitUsed})`
        );

        return { messages, nextCursor, hasMore: true, truncated: false };
      }

      messages.push(...eventMessages);
      bytesSoFar += eventBytes;
      eventsConsumed++;
    }

    // -------------------------------------------------------------------------
    // 6. Build next-page cursor when the upstream returned a continuation token.
    //    At this point we've consumed all of pageEvents without hitting the
    //    budget, so if the upstream has more pages we advance to the next one
    //    (offset = 0). Store `pageSize` in the cursor so the next call uses
    //    the same maxResults value.
    // -------------------------------------------------------------------------
    const nextCursor = upstreamNextToken
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            sessionId,
            pageToken: upstreamNextToken, // advance to next upstream page
            // offset absent → 0 (start from beginning of next page)
            pageSize: limitUsed,
          } satisfies PageCursorV1),
          'utf-8'
        ).toString('base64url')
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
