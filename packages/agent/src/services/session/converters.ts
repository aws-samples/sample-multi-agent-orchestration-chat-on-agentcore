/**
 * Conversion utilities for Strands `Message` ⇄ AgentCore Memory `PayloadType`.
 *
 * Two payload shapes are stored in AgentCore Memory:
 *
 *   - **Conversational** — single-text messages, encoded as
 *     `{ conversational: { role, content: { text } } }`.
 *   - **Blob** — anything richer than a single text block (tool use,
 *     tool result, image, multiple blocks): encoded as
 *     `{ blob: <utf8 bytes of JSON> }` whose JSON is a `WireBlobPayloadV2`.
 *
 * The blob path delegates content-block (de)serialisation to
 * {@link content-block-codec.ts}. That codec defends against the SDK's
 * `toJSON()` dropping the `type` discriminator — see codec docs for full
 * background.
 */
import { Message, TextBlock, type Role, type ContentBlock } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';
import { contentBlockToWire, wireToContentBlock } from '../../libs/codec/content-block-codec.js';
import {
  WIRE_SCHEMA_VERSION,
  type WireBlobPayloadV2,
  type WireContentBlock,
  type WireRole,
} from '../../libs/codec/content-block-codec.types.js';

/**
 * Type definition for AgentCore Memory Conversational Payload
 */
export interface ConversationalPayload {
  conversational: {
    content: { text: string };
    role: 'USER' | 'ASSISTANT';
  };
}

/**
 * Type definition for AgentCore Memory Blob Payload
 */
export interface BlobPayload {
  blob: Uint8Array;
}

/**
 * Type definition for AgentCore Memory PayloadType (Union type)
 */
export type AgentCorePayload = ConversationalPayload | BlobPayload;

// ---------------------------------------------------------------------------
// Strands Message → AgentCore Payload
// ---------------------------------------------------------------------------

/**
 * Convert a Strands `Message` to an AgentCore `Payload`.
 *
 * Single-textBlock messages take the lightweight `conversational` shape.
 * Anything else (tool use/result, images, multi-block) is serialised
 * through the wire codec into a `blob` payload that includes the
 * `schemaVersion` discriminator the read path uses to choose its parser.
 */
export function messageToAgentCorePayload(message: Message): AgentCorePayload {
  // Empty content → minimum-viable conversational payload (Bedrock rejects '')
  if (!message.content || message.content.length === 0) {
    const agentCoreRole = message.role === 'user' ? 'USER' : 'ASSISTANT';
    return {
      conversational: {
        content: { text: ' ' },
        role: agentCoreRole,
      },
    };
  }

  // Fast-path: single textBlock → conversational
  const hasNonTextContent = message.content.some((block) => block.type !== 'textBlock');
  if (!hasNonTextContent && message.content.length === 1) {
    const textBlock = message.content[0];
    if (textBlock.type === 'textBlock' && 'text' in textBlock) {
      const agentCoreRole = message.role === 'user' ? 'USER' : 'ASSISTANT';
      return {
        conversational: {
          content: { text: textBlock.text || ' ' },
          role: agentCoreRole,
        },
      };
    }
  }

  // Rich content → blob payload through the codec.
  // Note: we do NOT use `JSON.stringify(message.content)` directly because
  // the SDK's class `toJSON()` strips the `type` discriminator we depend
  // on; see content-block-codec.ts for details.
  const wireContent: WireContentBlock[] = message.content.map((block) =>
    contentBlockToWire(block as ContentBlock)
  );

  const blobData: WireBlobPayloadV2 = {
    schemaVersion: WIRE_SCHEMA_VERSION,
    messageType: 'content',
    role: message.role as WireRole,
    content: wireContent,
  };

  const encoder = new TextEncoder();
  return { blob: encoder.encode(JSON.stringify(blobData)) };
}

// ---------------------------------------------------------------------------
// AgentCore Payload → Strands Message
// ---------------------------------------------------------------------------

/**
 * Convert an AgentCore `Payload` back into a Strands `Message`.
 *
 * Two shapes are accepted:
 *
 *   - **Conversational** — text-only messages.
 *   - **Blob** — JSON envelope produced by {@link messageToAgentCorePayload}.
 *     Each `content[]` entry is a `WireContentBlock` with an explicit
 *     `type` discriminator (`schemaVersion: 'v2-strands-sdk-1'`).
 *     Restored via {@link wireToContentBlock}.
 *
 * Blocks without a `type` discriminator are dropped with a warning. Such
 * blocks could only originate from a `JSON.stringify(message.content)`
 * code path that bypassed the codec — that path no longer exists in this
 * repository (see {@link content-block-codec.ts} for why the codec exists).
 *
 * Unknown payloads fall back to a single-space `TextBlock` so Bedrock
 * `ValidationException` ('content cannot be empty') is avoided.
 */
export function agentCorePayloadToMessage(payload: AgentCorePayload): Message {
  // Conversational payload — plain text.
  if ('conversational' in payload) {
    const strandsRole: Role = payload.conversational.role === 'USER' ? 'user' : 'assistant';
    return new Message({
      role: strandsRole,
      content: [new TextBlock(payload.conversational.content.text)],
    });
  }

  // Blob payload — decode → JSON parse → restore each typed block.
  if ('blob' in payload && payload.blob) {
    try {
      const blobString = decodeBlobToString(payload.blob);
      if (blobString === null) {
        return fallbackMessage('Unknown blob shape');
      }

      const parsed = JSON.parse(blobString) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        return fallbackMessage('Blob is not a JSON object');
      }

      const role = (typeof parsed.role === 'string' ? parsed.role : 'assistant') as Role;
      const rawContent = Array.isArray(parsed.content) ? parsed.content : [];

      const restored: ContentBlock[] = rawContent
        .filter(
          (raw): raw is WireContentBlock =>
            !!raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string'
        )
        .map((wire) => wireToContentBlock(wire));

      // If every block was filtered out, emit fallback so downstream
      // model providers don't choke on an empty content array.
      if (restored.length === 0) {
        logger.warn(
          {
            messageType: parsed.messageType,
            schemaVersion: parsed.schemaVersion,
            originalBlockCount: rawContent.length,
          },
          'agentCorePayloadToMessage: no content blocks carried a recognised type, using fallback'
        );
        return fallbackMessage('All blocks unrecognised');
      }

      return new Message({ role, content: restored });
    } catch (error) {
      // Don't log raw blob (may carry tool execution secrets); size only.
      const blobSize =
        payload.blob instanceof Uint8Array
          ? payload.blob.byteLength
          : typeof payload.blob === 'string'
            ? (payload.blob as string).length
            : undefined;
      logger.error({ err: error, blobSize }, 'Failed to parse blob payload');
    }
  }

  return fallbackMessage('Unknown payload type');
}

/**
 * Decode the various wire encodings AgentCore Memory may hand us into a
 * UTF-8 string. Returns `null` when the input is not a recognised binary
 * representation — caller should warn + fall back.
 */
function decodeBlobToString(blob: unknown): string | null {
  if (blob instanceof Uint8Array) {
    return new TextDecoder().decode(blob);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(blob)) {
    return (blob as Buffer).toString('utf8');
  }
  if (typeof blob === 'string') {
    // Try base64 first — that's what AWS SDK v3 typically yields when a
    // raw byte array crosses a HTTP boundary — but fall back to direct
    // UTF-8 if the bytes don't look like base64.
    try {
      return Buffer.from(blob, 'base64').toString('utf8');
    } catch {
      return blob;
    }
  }
  return null;
}

/**
 * Build a single-space TextBlock fallback message. Bedrock rejects an
 * empty `content` array with `ValidationException`, so we always emit at
 * least one block.
 */
function fallbackMessage(reason: string): Message {
  logger.warn({ reason }, 'agentCorePayloadToMessage: emitting fallback empty message');
  return new Message({
    role: 'assistant',
    content: [new TextBlock(' ')],
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * Extract eventId from AgentCore Event
 */
export function extractEventId(event: { eventId?: string }): string {
  return event.eventId || '';
}

/**
 * Get the current timestamp (for AgentCore Event)
 */
export function getCurrentTimestamp(): Date {
  return new Date();
}
