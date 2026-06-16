/**
 * AgentCore Memory wire-format decoding — IMPLEMENTATION DETAIL of
 * AgentCoreMemoryService.
 *
 * Everything that understands the agent's persisted blob payload lives here:
 * the blob envelope, the per-block content shape, and the conversion to the
 * UI-facing {@link MessageContent}. The service module stays in terms of the
 * domain message types and never touches the wire bytes directly.
 *
 * The agent's wire format is intentionally NOT shared as a typed contract
 * between agent and backend: the backend deliberately keeps zero dependency on
 * `@strands-agents/sdk` to keep its image small. The shape mirrors what
 * `packages/agent/src/libs/codec/content-block-codec.ts` emits — every block
 * carries a `type` discriminator stamped by the codec, never by the SDK's class
 * `toJSON()`.
 */

import { createLogger } from '../../libs/logger/index.js';

const log = createLogger('AgentCoreMemoryService');

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
  | { type: 'image'; image: { base64: string; mimeType: string; fileName?: string } }
  | { type: 'reasoning'; reasoning: { text: string } };

/**
 * Backend-local content block shape used to interpret AgentCore Memory blob
 * payloads written by the agent.
 */
export interface BackendContentBlock {
  type: string;
  text?: string;
  name?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  status?: string;
  // ImageBlock fields
  format?: string;
  base64?: string;
  // ReasoningBlock fields. `signature` / `redactedContentBase64` are
  // round-trip-only metadata the agent persists; they are intentionally NOT
  // surfaced to the UI (only `text` is converted below).
  signature?: string;
  redactedContentBase64?: string;
}

/**
 * Blob data envelope written by the agent. `schemaVersion` is
 * `'v2-strands-sdk-1'` for current writes.
 */
export interface BlobData {
  schemaVersion?: string;
  messageType: 'content';
  role: string;
  content: BackendContentBlock[];
}

const FORMAT_TO_MIME_TYPE: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Convert agent-side wire content blocks to UI-facing MessageContent.
 *
 * Blocks without a `type` discriminator are dropped: the producer always goes
 * through the agent's `contentBlockToWire`, so a typeless block can only
 * originate from a code path that bypassed the codec — there is no such path in
 * this repository.
 */
export function convertToMessageContents(contentBlocks: BackendContentBlock[]): MessageContent[] {
  const messageContents: MessageContent[] = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
      // Don't log the block itself — it may carry tool execution results
      // (shell output, MCP responses) that contain secrets. Log shape only.
      log.warn(
        { keys: block && typeof block === 'object' ? Object.keys(block) : [] },
        'Skipping content block without a `type` discriminator'
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
          messageContents.push({
            type: 'image',
            image: {
              base64: block.base64,
              mimeType: FORMAT_TO_MIME_TYPE[block.format] || 'image/png',
            },
          });
        }
        break;

      case 'reasoningBlock':
        // Surface only the human-readable reasoning text. A reasoning block with
        // empty/absent text (signature- or redactedContent-only) carries nothing
        // displayable, so it is dropped. redactedContentBase64 is never exposed.
        if (typeof block.text === 'string' && block.text.length > 0) {
          messageContents.push({ type: 'reasoning', reasoning: { text: block.text } });
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
 * Parse a persisted blob payload (Uint8Array / Buffer / base64 string) into a
 * {@link BlobData}. Returns null for unparseable input or a non-`content`
 * message type.
 */
export function parseBlobPayload(blob: Uint8Array | Buffer | unknown): BlobData | null {
  try {
    let blobString: string;

    if (blob instanceof Uint8Array) {
      blobString = new TextDecoder().decode(blob);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(blob)) {
      blobString = (blob as Buffer).toString('utf8');
    } else if (typeof blob === 'string') {
      // AWS SDK hands blobs back base64-encoded; fall back to the raw string
      // if it is not valid base64.
      try {
        blobString = Buffer.from(blob, 'base64').toString('utf8');
      } catch {
        blobString = blob;
      }
    } else {
      log.warn({ blobType: typeof blob }, 'Unknown blob type');
      return null;
    }

    const blobData = JSON.parse(blobString) as BlobData;
    return blobData.messageType === 'content' ? blobData : null;
  } catch (error) {
    log.error({ err: error }, 'Failed to parse blob payload:');
    log.error(
      { sample: typeof blob === 'string' ? blob.substring(0, 100) + '...' : typeof blob },
      'Raw blob sample'
    );
    return null;
  }
}
