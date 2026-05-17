/**
 * Conversion utilities for Strands Message and AgentCore Memory PayloadType
 */
import {
  Message,
  TextBlock,
  ImageBlock,
  type Role,
  type ContentBlock,
  type JSONValue,
} from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';

/**
 * Type definition for ToolUse data
 */
interface ToolUseData {
  toolType: 'toolUse';
  name: string;
  toolUseId: string;
  input: JSONValue;
}

/**
 * Type definition for ToolResult data
 */
interface ToolResultData {
  toolType: 'toolResult';
  toolUseId: string;
  content: JSONValue;
  isError: boolean;
}

/**
 * Union type for tool data
 */
type ToolData = ToolUseData | ToolResultData;

/**
 * Type definition for ImageBlock data (for serialization)
 */
interface ImageBlockData {
  type: 'imageBlock';
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  base64: string;
}

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
 * Serializable content block type
 */
type SerializableContentBlock = ContentBlock | ImageBlockData;

/**
 * Type definition for blob data content (new format)
 */
interface BlobData {
  messageType: 'content';
  role: string;
  content: SerializableContentBlock[];
}

/**
 * Type definition for legacy blob data content (for backward compatibility)
 */
interface LegacyBlobData {
  messageType: 'tool';
  role: string;
  toolType: 'toolUse' | 'toolResult';
  name?: string;
  toolUseId: string;
  input?: JSONValue;
  content?: JSONValue;
  isError?: boolean;
}

/**
 * Type definition for AgentCore Memory PayloadType (Union type)
 */
export type AgentCorePayload = ConversationalPayload | BlobPayload;

/**
 * Convert ImageBlock to a serializable format
 * @param block ImageBlock
 * @returns ImageBlockData (in Base64 format)
 */
function serializeImageBlock(block: ContentBlock): ImageBlockData | null {
  if (block.type !== 'imageBlock') return null;

  // Get bytes from ImageBlock source
  const imageBlock = block as unknown as {
    type: 'imageBlock';
    format?: string;
    source?: { bytes?: Uint8Array };
  };

  if (!imageBlock.source?.bytes) return null;

  // Convert Uint8Array to Base64
  const base64 = Buffer.from(imageBlock.source.bytes).toString('base64');

  return {
    type: 'imageBlock',
    format: (imageBlock.format as ImageBlockData['format']) || 'png',
    base64,
  };
}

/**
 * Convert Strands Message to AgentCore Payload
 * @param message Strands Message
 * @returns AgentCore Payload (ConversationalPayload or BlobPayload)
 */
export function messageToAgentCorePayload(message: Message): AgentCorePayload {
  // When content array is empty or does not exist
  if (!message.content || message.content.length === 0) {
    const agentCoreRole = message.role === 'user' ? 'USER' : 'ASSISTANT';
    return {
      conversational: {
        content: { text: ' ' }, // Minimum 1 character
        role: agentCoreRole,
      },
    };
  }

  // Check if content array contains non-text content (toolUse/toolResult/imageBlock)
  const hasNonTextContent = message.content.some((block) => block.type !== 'textBlock');

  // Use conversational payload for simple text-only messages
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

  // Complex messages (containing toolUse/toolResult/imageBlock, or multiple content blocks) use blob payload
  // ImageBlock is serialized to Base64 for storage
  const serializedContent: SerializableContentBlock[] = message.content.map((block) => {
    if (block.type === 'imageBlock') {
      const serialized = serializeImageBlock(block);
      if (serialized) return serialized;
    }
    return block;
  });

  const blobData: BlobData = {
    messageType: 'content',
    role: message.role,
    content: serializedContent,
  };

  // Serialize to JSON string then encode as Uint8Array
  const encoder = new TextEncoder();
  return {
    blob: encoder.encode(JSON.stringify(blobData)),
  };
}

/**
 * Convert AgentCore Payload to Strands Message
 * @param payload AgentCore Payload (ConversationalPayload or BlobPayload)
 * @returns Strands Message
 */
export function agentCorePayloadToMessage(payload: AgentCorePayload): Message {
  // When conversational payload
  if ('conversational' in payload) {
    const strandsRole = payload.conversational.role === 'USER' ? 'user' : 'assistant';
    const textBlock = new TextBlock(payload.conversational.content.text);
    return new Message({
      role: strandsRole,
      content: [textBlock],
    });
  }

  // When blob payload
  if ('blob' in payload && payload.blob) {
    try {
      let blobData: BlobData | null = null;

      // 1. When Uint8Array or Buffer (Buffer extends Uint8Array in Node.js)
      if (payload.blob instanceof Uint8Array) {
        const decoder = new TextDecoder();
        const blobString = decoder.decode(payload.blob);
        blobData = JSON.parse(blobString);
      }
      // 2. When direct object (old format - backward compatibility)
      else if (typeof payload.blob === 'object' && payload.blob !== null) {
        const blobObj = payload.blob as Record<string, unknown>;

        // Check for old format
        if (blobObj.messageType === 'tool') {
          blobData = blobObj as unknown as BlobData;
        }
      }
      // 3. When string (possibly base64 encoded)
      else if (typeof payload.blob === 'string') {
        try {
          // Attempt base64 decoding
          const decodedString = Buffer.from(payload.blob, 'base64').toString('utf8');
          blobData = JSON.parse(decodedString);
        } catch {
          // If not base64, parse directly as JSON
          blobData = JSON.parse(payload.blob);
        }
      }

      // Process when blobData is obtained
      if (blobData && (blobData.messageType === 'content' || blobData.messageType === 'tool')) {
        const strandsRole = blobData.role as Role;

        // New format: save the entire content array
        if (blobData.messageType === 'content') {
          // Restore ImageBlockData to ImageBlock
          const restoredContent: ContentBlock[] = blobData.content.map((block) => {
            // Restore ImageBlockData to ImageBlock
            if (
              block.type === 'imageBlock' &&
              'base64' in block &&
              typeof (block as ImageBlockData).base64 === 'string'
            ) {
              const imageData = block as ImageBlockData;
              const bytes = new Uint8Array(Buffer.from(imageData.base64, 'base64'));
              return new ImageBlock({
                format: imageData.format,
                source: { bytes },
              });
            }
            return block as ContentBlock;
          });

          return new Message({
            role: strandsRole,
            content: restoredContent,
          });
        }

        // Old format: process single toolUse/toolResult for backward compatibility
        if (blobData.messageType === 'tool') {
          const legacyBlobData = blobData as unknown as LegacyBlobData;
          const content = createContentBlockFromToolData(legacyBlobData);
          return new Message({
            role: strandsRole,
            content: [content],
          });
        }
      } else {
        // Log only the shape — blobData.content carries tool results that
        // may include secrets.
        logger.warn(
          {
            messageType: (blobData as { messageType?: unknown })?.messageType,
            role: (blobData as { role?: unknown })?.role,
          },
          'Blob data does not have expected structure'
        );
      }
    } catch (error) {
      // Do not log `payload.blob` itself — it carries tool execution results
      // (shell output, MCP responses, etc.) that may contain secrets. Size
      // is enough to diagnose parse failures.
      const blobSize =
        payload.blob instanceof Uint8Array
          ? payload.blob.byteLength
          : typeof payload.blob === 'string'
            ? (payload.blob as string).length
            : undefined;
      logger.error({ err: error, blobSize }, 'Failed to parse blob data');
      // Proceed to fallback on parse error
    }
  }

  // Fallback: for unknown payload types — use a single space to avoid Bedrock ValidationException
  // (Bedrock rejects ContentBlocks with a blank text field)
  logger.warn('Unknown payload type, creating empty message');
  return new Message({
    role: 'assistant',
    content: [new TextBlock(' ')],
  });
}

/**
 * Extract eventId from AgentCore Event
 * @param event AgentCore Event object
 * @returns eventId
 */
export function extractEventId(event: { eventId?: string }): string {
  return event.eventId || '';
}

/**
 * Create Strands ContentBlock from tool data
 * @param toolData Tool data (ToolData or LegacyBlobData)
 * @returns ContentBlock
 */
function createContentBlockFromToolData(toolData: ToolData | LegacyBlobData): ContentBlock {
  if (toolData.toolType === 'toolUse') {
    // Create ToolUseBlock (based on exact type from Strands SDK)
    return {
      type: 'toolUseBlock',
      name: toolData.name,
      toolUseId: toolData.toolUseId,
      input: toolData.input,
    } as unknown as ContentBlock;
  }

  if (toolData.toolType === 'toolResult') {
    // Create ToolResultBlock (based on exact type from Strands SDK)
    return {
      type: 'toolResultBlock',
      toolUseId: toolData.toolUseId,
      content: toolData.content,
      isError: toolData.isError,
      status: 'success', // Required property in Strands SDK
    } as unknown as ContentBlock;
  }

  // Exhaustive check: compile-time error if new toolType is added without handling
  const _exhaustive: never = toolData.toolType as never;
  throw new Error(`Unknown toolType: ${_exhaustive}`);
}

/**
 * Get the current timestamp (for AgentCore Event)
 * @returns Date object
 */
export function getCurrentTimestamp(): Date {
  return new Date();
}
