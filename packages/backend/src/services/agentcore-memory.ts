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
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config/index.js';
import { createAgentCoreClient } from '../libs/auth/scoped-credentials.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('AgentCoreMemoryService');

/**
 * Type definitions to supplement incomplete AWS SDK type definitions
 */
interface MemoryRecordSummary {
  memoryRecordId?: string;
  content?: string | { text?: string };
  createdAt?: Date;
  namespaces?: string[];
  memoryStrategyId?: string;
  metadata?: Record<string, unknown>;
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
 * ToolUse type definition
 */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status?: 'pending' | 'running' | 'completed' | 'error';
  originalToolUseId?: string;
}

/**
 * ToolResult type definition
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
 * Event information type definition (formatted for Frontend)
 */
export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant';
  contents: MessageContent[];
  timestamp: string; // ISO 8601 string
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
 * Backend-local content block shape used to interpret AgentCore Memory blob
 * payloads written by the agent.
 *
 * The agent's wire format is intentionally NOT shared as a typed contract
 * between agent and backend (see ADR `agentcore-memory-wire-format.md`):
 * the backend deliberately keeps zero dependency on `@strands-agents/sdk`
 * to keep its image small and its responsibilities clean. We instead pin
 * the wire shape here and rely on `schemaVersion` (added in agent codec
 * v2) plus salvage paths for any earlier-versioned data.
 */
interface BackendContentBlock {
  /**
   * Discriminator written by the agent's `content-block-codec.ts`. May be
   * absent in:
   *   - v1 blobs from SDK 0.1.x times (those used a different envelope
   *     shape and never reach this code path).
   *   - "bug-window" blobs from SDK 1.x sessions persisted between the
   *     1.x upgrade and the codec landing — those went through the SDK
   *     class `toJSON()` which strips `type` and emits Bedrock Converse
   *     wrappers (`{ toolUse: {...} }`, `{ toolResult: {...} }`,
   *     `{ image: {...} }`, `{ text: "..." }`).
   *
   * The salvage path below detects the latter and reconstructs the
   * structured shape this UI layer expects.
   */
  type?: string;
  text?: string;
  name?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  status?: string;
  // ImageBlock fields
  format?: string;
  base64?: string;
  source?: { bytes?: Uint8Array };
  // Bug-window Bedrock Converse wrappers (used by the salvage path).
  toolUse?: { name?: string; toolUseId?: string; input?: Record<string, unknown> };
  toolResult?: { toolUseId?: string; status?: string; content?: unknown };
  image?: { format?: string; base64?: string; source?: { bytes?: Uint8Array | string } };
}

/**
 * Blob data envelope written by the agent. `schemaVersion` is `'v2-strands-sdk-1'`
 * for current writes; legacy / corrupted payloads omit it and are still
 * tolerated via the per-block salvage path.
 */
interface BlobData {
  schemaVersion?: string;
  messageType: 'content';
  role: string;
  content: BackendContentBlock[];
}

/**
 * Normalise a single content block into one with a recognised `type`.
 *
 * Handles the SDK 1.x bug window where `JSON.stringify(message.content)`
 * produced `{ toolUse: {...} }` / `{ toolResult: {...} }` / `{ image: {...} }`
 * / `{ text: "..." }` wrappers without a `type` discriminator. These are
 * reconstructed from their Bedrock Converse shape so downstream switch
 * statements behave identically to a freshly-written v2 payload.
 *
 * Returns `null` when the block can't be salvaged at all.
 */
function normaliseBlock(block: BackendContentBlock): BackendContentBlock | null {
  // Already in v2 shape (or v1 SDK 0.1.x — both carry `type`).
  if (typeof block.type === 'string') return block;

  // Bug-window: { toolUse: {...} } wrapper.
  if (block.toolUse && typeof block.toolUse === 'object') {
    const tu = block.toolUse;
    if (tu.name && tu.toolUseId) {
      return {
        type: 'toolUseBlock',
        name: tu.name,
        toolUseId: tu.toolUseId,
        input: tu.input ?? {},
      };
    }
  }

  // Bug-window: { toolResult: {...} } wrapper.
  if (block.toolResult && typeof block.toolResult === 'object') {
    const tr = block.toolResult;
    if (tr.toolUseId) {
      return {
        type: 'toolResultBlock',
        toolUseId: tr.toolUseId,
        content: tr.content,
        status: tr.status === 'error' ? 'error' : 'success',
      };
    }
  }

  // Bug-window: bare `{ text: "..." }` wrapper (SDK 1.x TextBlock.toJSON()).
  if (typeof block.text === 'string') {
    return { type: 'textBlock', text: block.text };
  }

  // Bug-window: { image: { format, source: { bytes } } } wrapper.
  if (block.image && typeof block.image === 'object') {
    const im = block.image;
    if (im.format && im.source) {
      const sourceBytes = im.source.bytes;
      const base64 =
        typeof sourceBytes === 'string'
          ? sourceBytes
          : sourceBytes instanceof Uint8Array
            ? Buffer.from(sourceBytes).toString('base64')
            : (im.base64 ?? '');
      return { type: 'imageBlock', format: im.format, base64 };
    }
  }

  return null;
}

/**
 * Convert agent-side wire content blocks to UI-facing MessageContent.
 *
 * Each block is normalised first (see {@link normaliseBlock}) so the
 * switch downstream can treat v2 and salvaged bug-window payloads
 * uniformly.
 */
function convertToMessageContents(contentBlocks: BackendContentBlock[]): MessageContent[] {
  const messageContents: MessageContent[] = [];

  for (const raw of contentBlocks) {
    if (!raw || typeof raw !== 'object') continue;

    const block = normaliseBlock(raw);
    if (!block) {
      // Don't log the block itself — it may carry tool execution results
      // (shell output, MCP responses) that contain secrets. Log shape only.
      log.warn(
        { keys: Object.keys(raw) },
        'Unrecognised content block — neither v2 type nor bug-window wrapper'
      );
      continue;
    }

    switch (block.type) {
      case 'textBlock':
        if (typeof block.text === 'string') {
          messageContents.push({ type: 'text', text: block.text });
        }
        break;

      case 'toolUseBlock':
        if (block.name && block.toolUseId && block.input !== undefined) {
          messageContents.push({
            type: 'toolUse',
            toolUse: {
              id: block.toolUseId,
              name: block.name,
              input: block.input || {},
              status: 'completed', // Default status
              originalToolUseId: block.toolUseId,
            },
          });
        }
        break;

      case 'toolResultBlock':
        if (block.toolUseId) {
          messageContents.push({
            type: 'toolResult',
            toolResult: {
              toolUseId: block.toolUseId,
              content:
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content || {}),
              isError: block.status === 'error' || false,
            },
          });
        }
        break;

      case 'imageBlock':
        // Handle serialised ImageBlock (base64 format from agent codec).
        if (typeof block.base64 === 'string' && block.format) {
          // Map format to mimeType
          const formatToMimeType: Record<string, string> = {
            png: 'image/png',
            jpeg: 'image/jpeg',
            jpg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          };
          const mimeType = formatToMimeType[block.format] || 'image/png';

          messageContents.push({
            type: 'image',
            image: {
              base64: block.base64,
              mimeType,
            },
          });
        }
        break;

      default:
        log.warn(`Unknown ContentBlock type: ${block.type}`);
        break;
    }
  }

  return messageContents;
}

/**
 * Parse blob payload
 * @param blob Uint8Array or Buffer or base64 string
 * @returns Parsed BlobData
 */
function parseBlobPayload(blob: Uint8Array | Buffer | unknown): BlobData | null {
  try {
    let blobString: string;

    // For Uint8Array
    if (blob instanceof Uint8Array) {
      const decoder = new TextDecoder();
      blobString = decoder.decode(blob);
    }
    // For Buffer
    else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(blob)) {
      blobString = (blob as Buffer).toString('utf8');
    }
    // For string (base64 encoded string from AWS SDK)
    else if (typeof blob === 'string') {
      try {
        // Try base64 decoding
        const decodedBuffer = Buffer.from(blob, 'base64');
        blobString = decodedBuffer.toString('utf8');
      } catch {
        // Use directly if not base64
        blobString = blob;
      }
    }
    // For other cases
    else {
      log.warn({ blobType: typeof blob }, 'Unknown blob type');
      return null;
    }

    const blobData = JSON.parse(blobString) as BlobData;
    return blobData.messageType === 'content' ? blobData : null;
  } catch (error) {
    log.error({ err: error }, 'Failed to parse blob payload:');
    log.error(
      {
        sample: typeof blob === 'string' ? blob.substring(0, 100) + '...' : typeof blob,
      },
      'Raw blob sample'
    );
    return null;
  }
}

/**
 * Long-term memory record type definition
 */
export interface MemoryRecord {
  recordId: string;
  namespace: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Long-term memory record list type definition
 */
export interface MemoryRecordList {
  records: MemoryRecord[];
  nextToken?: string;
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
   * Get long-term memory record list
   * @param actorId User ID
   * @param memoryStrategyId Memory strategy ID (e.g., preference_builtin_cdkGen0001-L84bdDEgeO)
   * @param nextToken Pagination token
   * @returns Long-term memory record list
   */
  async listMemoryRecords(
    actorId: string,
    memoryStrategyId: string,
    nextToken?: string
  ): Promise<MemoryRecordList> {
    try {
      log.info(
        `Retrieving long-term memory record list: actorId=${actorId}, memoryStrategyId=${memoryStrategyId}`
      );

      // Fix namespace format to correct format
      const namespace = `/strategies/${memoryStrategyId}/actors/${actorId}`;

      const command = new ListMemoryRecordsCommand({
        memoryId: this.memoryId,
        namespace: namespace,
        memoryStrategyId: memoryStrategyId,
        maxResults: 50,
        nextToken: nextToken,
      });

      const response = await this.client.send(command);

      // Type assertion for cases where memoryRecordSummaries is not included in AWS SDK response type
      const extendedResponse = response as typeof response & {
        memoryRecordSummaries?: MemoryRecordSummary[];
      };

      if (!extendedResponse.memoryRecordSummaries) {
        log.info(`Long-term memory records not found: memoryStrategyId=${memoryStrategyId}`);
        return { records: [] };
      }

      const records: MemoryRecord[] = extendedResponse.memoryRecordSummaries.map(
        (record, index: number) => {
          // Debug log: Check structure of memoryRecordSummaries
          if (index < 2) {
            // Log only first 2 items
            log.info(
              {
                recordId: record.memoryRecordId,
                recordIdType: typeof record.memoryRecordId,
                availableKeys: Object.keys(record),
                fullRecord: record,
              },
              'Record %d structure:',
              index
            );
          }

          // Extract text property if content is an object
          let content = '';
          if (typeof record.content === 'object' && record.content?.text) {
            content = record.content.text;
          } else if (typeof record.content === 'string') {
            content = record.content;
          } else if (record.content) {
            content = JSON.stringify(record.content);
          }

          // Warning log if recordId is empty
          const recordId = record.memoryRecordId || '';
          if (!recordId) {
            log.warn(record, 'Empty recordId found in record %d:', index);
          }

          return {
            recordId: recordId,
            namespace: namespace,
            content: content,
            createdAt: record.createdAt?.toISOString() || new Date().toISOString(),
            updatedAt: record.createdAt?.toISOString() || new Date().toISOString(), // AWS SDK doesn't provide updatedAt
          };
        }
      );

      log.info(`Retrieved ${records.length} long-term memory records`);
      return {
        records,
        nextToken: response.nextToken,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        log.info(`Long-term memory records do not exist: memoryStrategyId=${memoryStrategyId}`);
        return { records: [] };
      }
      log.error({ err: error }, 'Long-term memory record list retrieval error:');
      throw error;
    }
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
    try {
      log.info(`Executing semantic search: query=${query}, memoryStrategyId=${memoryStrategyId}`);

      // Fix namespace format to correct format
      const namespace = `/strategies/${memoryStrategyId}/actors/${actorId}`;

      const retrieveParams: RetrieveMemoryRecordsParams = {
        memoryId: this.memoryId,
        namespace: namespace,
        searchCriteria: {
          searchQuery: query,
          memoryStrategyId: memoryStrategyId,
          topK: topK,
        },
        maxResults: 50,
      };

      const command = new RetrieveMemoryRecordsCommand(retrieveParams);

      const response = await this.client.send(command);

      // Type assertion for cases where memoryRecordSummaries is not included in AWS SDK response type
      const extendedResponse = response as typeof response & {
        memoryRecordSummaries?: MemoryRecordSummary[];
      };

      if (!extendedResponse.memoryRecordSummaries) {
        log.info(`Semantic search results not found: query=${query}`);
        return [];
      }

      const records: MemoryRecord[] = extendedResponse.memoryRecordSummaries.map(
        (record: MemoryRecordSummary, index: number) => {
          // Debug log: Check structure of memoryRecordSummaries
          if (index < 2) {
            // Log only first 2 items
            log.info(
              {
                recordId: record.memoryRecordId,
                recordIdType: typeof record.memoryRecordId,
                availableKeys: Object.keys(record),
                fullRecord: record,
              },
              'Retrieve record %d structure:',
              index
            );
          }

          // Extract text property if content is an object
          let content = '';
          if (typeof record.content === 'object' && record.content?.text) {
            content = record.content.text;
          } else if (typeof record.content === 'string') {
            content = record.content;
          } else if (record.content) {
            content = JSON.stringify(record.content);
          }

          // Warning log if recordId is empty
          const recordId = record.memoryRecordId || '';
          if (!recordId) {
            log.warn(record, 'Empty recordId found in retrieve record %d:', index);
          }

          return {
            recordId: recordId,
            namespace: namespace,
            content: content,
            createdAt: record.createdAt?.toISOString() || new Date().toISOString(),
            updatedAt: record.createdAt?.toISOString() || new Date().toISOString(), // AWS SDK doesn't provide updatedAt
          };
        }
      );

      log.info(`Retrieved ${records.length} semantic search results`);
      return records;
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        log.info(`Semantic search target does not exist: memoryStrategyId=${memoryStrategyId}`);
        return [];
      }
      log.error({ err: error }, 'Semantic search error:');
      throw error;
    }
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
  const client = await createAgentCoreClient(req);
  return new AgentCoreMemoryService(config.AGENTCORE_MEMORY_ID, client);
}
