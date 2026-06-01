/**
 * Unit tests for session/converters.ts
 */

import { describe, it, expect } from '@jest/globals';
import { Message, TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock } from '@strands-agents/sdk';
import {
  messageToAgentCorePayload,
  agentCorePayloadToMessage,
  extractEventId,
  getCurrentTimestamp,
  type ConversationalPayload,
  type BlobPayload,
} from '../converters.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextMessage(role: 'user' | 'assistant', text: string): Message {
  return new Message({ role, content: [new TextBlock(text)] });
}

function decodeBlob(blob: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(blob));
}

// ---------------------------------------------------------------------------
// messageToAgentCorePayload
// ---------------------------------------------------------------------------

describe('messageToAgentCorePayload', () => {
  describe('empty / null content', () => {
    it('returns conversational payload with single-space text when content is empty array', () => {
      const msg = new Message({ role: 'user', content: [] });
      const payload = messageToAgentCorePayload(msg) as ConversationalPayload;
      expect('conversational' in payload).toBe(true);
      expect(payload.conversational.content.text).toBe(' ');
    });

    it('maps role user → USER for empty content', () => {
      const msg = new Message({ role: 'user', content: [] });
      const payload = messageToAgentCorePayload(msg) as ConversationalPayload;
      expect(payload.conversational.role).toBe('USER');
    });

    it('maps role assistant → ASSISTANT for empty content', () => {
      const msg = new Message({ role: 'assistant', content: [] });
      const payload = messageToAgentCorePayload(msg) as ConversationalPayload;
      expect(payload.conversational.role).toBe('ASSISTANT');
    });
  });

  describe('single text block → conversational payload', () => {
    it('returns conversational payload for a single textBlock', () => {
      const msg = makeTextMessage('user', 'Hello world');
      const payload = messageToAgentCorePayload(msg) as ConversationalPayload;
      expect('conversational' in payload).toBe(true);
      expect(payload.conversational.content.text).toBe('Hello world');
    });

    it('maps user role correctly', () => {
      const payload = messageToAgentCorePayload(
        makeTextMessage('user', 'hi')
      ) as ConversationalPayload;
      expect(payload.conversational.role).toBe('USER');
    });

    it('maps assistant role correctly', () => {
      const payload = messageToAgentCorePayload(
        makeTextMessage('assistant', 'hello')
      ) as ConversationalPayload;
      expect(payload.conversational.role).toBe('ASSISTANT');
    });
  });

  describe('multiple text blocks → blob payload', () => {
    it('returns blob payload when content has multiple text blocks', () => {
      const msg = new Message({
        role: 'assistant',
        content: [new TextBlock('part 1'), new TextBlock('part 2')],
      });
      const payload = messageToAgentCorePayload(msg) as BlobPayload;
      expect('blob' in payload).toBe(true);
      expect(payload.blob).toBeInstanceOf(Uint8Array);
    });

    it('blob encodes messageType=content with role and both text blocks', () => {
      const msg = new Message({
        role: 'user',
        content: [new TextBlock('a'), new TextBlock('b')],
      });
      const payload = messageToAgentCorePayload(msg) as BlobPayload;
      const data = decodeBlob(payload.blob) as {
        messageType: string;
        role: string;
        content: unknown[];
      };
      expect(data.messageType).toBe('content');
      expect(data.role).toBe('user');
      expect(data.content).toHaveLength(2);
    });
  });

  describe('toolUse / toolResult content → blob payload', () => {
    it('returns blob payload when content contains a toolUseBlock', () => {
      const msg = new Message({
        role: 'assistant',
        content: [
          {
            type: 'toolUseBlock',
            name: 'myTool',
            toolUseId: 'tu-1',
            input: { key: 'value' },
          } as unknown as TextBlock,
        ],
      });
      const payload = messageToAgentCorePayload(msg) as BlobPayload;
      expect('blob' in payload).toBe(true);
      const data = decodeBlob(payload.blob) as { messageType: string; content: { type: string }[] };
      expect(data.messageType).toBe('content');
      expect(data.content[0].type).toBe('toolUseBlock');
    });

    it('returns blob payload when content contains a toolResultBlock', () => {
      const msg = new Message({
        role: 'user',
        content: [
          {
            type: 'toolResultBlock',
            toolUseId: 'tu-1',
            content: 'result',
            status: 'success',
          } as unknown as TextBlock,
        ],
      });
      const payload = messageToAgentCorePayload(msg) as BlobPayload;
      expect('blob' in payload).toBe(true);
    });
  });

  describe('imageBlock content → blob with base64 serialization', () => {
    it('serializes imageBlock bytes to base64 in blob payload', () => {
      const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
      const imgBlock = new ImageBlock({ format: 'png', source: { bytes } });
      const msg = new Message({ role: 'user', content: [imgBlock] });

      const payload = messageToAgentCorePayload(msg) as BlobPayload;
      expect('blob' in payload).toBe(true);

      const data = decodeBlob(payload.blob) as {
        messageType: string;
        content: { type: string; format: string; base64: string }[];
      };
      expect(data.messageType).toBe('content');
      expect(data.content[0].type).toBe('imageBlock');
      expect(data.content[0].format).toBe('png');
      // base64 should be a valid base64 string representing the bytes
      const decoded = Buffer.from(data.content[0].base64, 'base64');
      expect(Array.from(decoded)).toEqual([137, 80, 78, 71]);
    });

    it('defaults to png format when imageBlock has no format specified', () => {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      // Create imageBlock without explicit format (constructor may set undefined)
      const imgBlock = new ImageBlock({ source: { bytes } } as {
        format: 'png';
        source: { bytes: Uint8Array };
      });
      const msg = new Message({ role: 'user', content: [imgBlock] });

      const payload = messageToAgentCorePayload(msg) as BlobPayload;
      const data = decodeBlob(payload.blob) as {
        content: { type: string; format: string; base64: string }[];
      };
      // serializeImageBlock defaults to 'png' when format is missing
      expect(data.content[0].format).toBe('png');
    });
  });
});

// ---------------------------------------------------------------------------
// agentCorePayloadToMessage
// ---------------------------------------------------------------------------

describe('agentCorePayloadToMessage', () => {
  describe('conversational payload → Message', () => {
    it('converts USER conversational payload to user Message with TextBlock', () => {
      const payload: ConversationalPayload = {
        conversational: { content: { text: 'Hello' }, role: 'USER' },
      };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('user');
      expect(msg.content).toHaveLength(1);
      const block = msg.content[0] as TextBlock;
      expect(block.type).toBe('textBlock');
      expect(block.text).toBe('Hello');
    });

    it('converts ASSISTANT conversational payload to assistant Message', () => {
      const payload: ConversationalPayload = {
        conversational: { content: { text: 'Hi there' }, role: 'ASSISTANT' },
      };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('assistant');
      expect((msg.content[0] as TextBlock).text).toBe('Hi there');
    });
  });

  describe('blob as Uint8Array (new format, messageType=content)', () => {
    it('restores a text-only message from Uint8Array blob', () => {
      const blobData = {
        messageType: 'content',
        role: 'user',
        content: [{ type: 'textBlock', text: 'restored text' }],
      };
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode(JSON.stringify(blobData)) };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('user');
      expect((msg.content[0] as TextBlock).type).toBe('textBlock');
      expect((msg.content[0] as TextBlock).text).toBe('restored text');
    });

    it('restores multiple content blocks from Uint8Array blob', () => {
      const blobData = {
        messageType: 'content',
        role: 'assistant',
        content: [
          { type: 'textBlock', text: 'part 1' },
          { type: 'textBlock', text: 'part 2' },
        ],
      };
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode(JSON.stringify(blobData)) };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.content).toHaveLength(2);
    });
  });

  describe('blob as Buffer', () => {
    it('restores message from Buffer blob', () => {
      const blobData = {
        messageType: 'content',
        role: 'assistant',
        content: [{ type: 'textBlock', text: 'from buffer' }],
      };
      const payload = { blob: Buffer.from(JSON.stringify(blobData)) as unknown as Uint8Array };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('assistant');
      expect((msg.content[0] as TextBlock).text).toBe('from buffer');
    });

    it('restores non-ASCII content from Buffer blob (utf8 verification)', () => {
      const nonAsciiText = 'H\u00e9llo W\u00f6rld \ud83d\ude80\ud83c\udf0d';
      const blobData = {
        messageType: 'content',
        role: 'user',
        content: [{ type: 'textBlock', text: nonAsciiText }],
      };
      const payload = {
        blob: Buffer.from(JSON.stringify(blobData), 'utf8') as unknown as Uint8Array,
      };
      const msg = agentCorePayloadToMessage(payload);
      expect((msg.content[0] as TextBlock).text).toBe(nonAsciiText);
    });
  });

  describe('typeless content blocks (codec-bypassed writes)', () => {
    /**
     * The producer always goes through `contentBlockToWire`, which
     * stamps `type` on every block. A blob whose `content[]` entries
     * are missing `type` could only originate from a code path that
     * bypassed the codec; we drop those entries rather than try to
     * reconstruct them.
     */
    it('drops blocks without a `type` discriminator and falls back to empty message', () => {
      const blobData = {
        messageType: 'content',
        role: 'assistant',
        content: [
          { toolUse: { name: 'myTool', toolUseId: 'tu-42', input: {} } },
          { text: 'no type field' },
        ],
      };
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode(JSON.stringify(blobData)) };
      const msg = agentCorePayloadToMessage(payload);
      // All blocks were filtered → fallback single-space TextBlock.
      expect(msg.content).toHaveLength(1);
      expect((msg.content[0] as TextBlock).text).toBe(' ');
    });

    it('keeps typed blocks when mixed with typeless ones', () => {
      const blobData = {
        messageType: 'content',
        role: 'assistant',
        content: [
          { type: 'textBlock', text: 'kept' },
          { text: 'dropped' }, // typeless, filtered out
        ],
      };
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode(JSON.stringify(blobData)) };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.content).toHaveLength(1);
      expect((msg.content[0] as TextBlock).text).toBe('kept');
    });
  });

  describe('blob as base64-encoded string', () => {
    it('restores message from base64-encoded string blob', () => {
      const blobData = {
        messageType: 'content',
        role: 'user',
        content: [{ type: 'textBlock', text: 'from base64' }],
      };
      const base64str = Buffer.from(JSON.stringify(blobData)).toString('base64');
      const payload = { blob: base64str as unknown as Uint8Array };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('user');
      expect((msg.content[0] as TextBlock).text).toBe('from base64');
    });
  });

  describe('invalid blob data → fallback empty message', () => {
    it('returns fallback assistant message with single-space text on invalid JSON', () => {
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode('not-valid-json!!!') };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('assistant');
      expect(msg.content).toHaveLength(1);
      // Must not be blank — Bedrock rejects ContentBlocks with an empty text field
      expect((msg.content[0] as TextBlock).text).toBe(' ');
    });

    it('returns fallback message when blob has no recognized messageType', () => {
      const blobData = { messageType: 'unknown', role: 'user', content: [] };
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode(JSON.stringify(blobData)) };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.role).toBe('assistant');
    });
  });

  describe('ImageBlock restoration from base64', () => {
    it('restores ImageBlock from serialized base64 imageBlock data', () => {
      const originalBytes = new Uint8Array([1, 2, 3, 4]);
      const blobData = {
        messageType: 'content',
        role: 'user',
        content: [
          {
            type: 'imageBlock',
            format: 'jpeg',
            base64: Buffer.from(originalBytes).toString('base64'),
          },
        ],
      };
      const encoder = new TextEncoder();
      const payload: BlobPayload = { blob: encoder.encode(JSON.stringify(blobData)) };
      const msg = agentCorePayloadToMessage(payload);
      expect(msg.content).toHaveLength(1);
      const block = msg.content[0] as ImageBlock;
      expect(block.type).toBe('imageBlock');
      expect(block.format).toBe('jpeg');
      // source should contain the restored bytes
      const source = block.source as { bytes?: Uint8Array };
      expect(source.bytes).toBeDefined();
      expect(Array.from(source.bytes!)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('roundtrip serialization', () => {
    it('single text message roundtrips through conversational payload', () => {
      const original = makeTextMessage('user', 'roundtrip test');
      const payload = messageToAgentCorePayload(original);
      const restored = agentCorePayloadToMessage(payload);
      expect(restored.role).toBe('user');
      expect((restored.content[0] as TextBlock).text).toBe('roundtrip test');
    });

    it('multi-text message roundtrips through blob payload', () => {
      const original = new Message({
        role: 'assistant',
        content: [new TextBlock('first'), new TextBlock('second')],
      });
      const payload = messageToAgentCorePayload(original);
      const restored = agentCorePayloadToMessage(payload);
      expect(restored.role).toBe('assistant');
      expect(restored.content).toHaveLength(2);
      expect((restored.content[0] as TextBlock).text).toBe('first');
      expect((restored.content[1] as TextBlock).text).toBe('second');
    });

    it('imageBlock message roundtrips with base64 encoding/decoding', () => {
      const bytes = new Uint8Array([255, 216, 255, 224]); // JPEG magic bytes
      const imgBlock = new ImageBlock({ format: 'jpeg', source: { bytes } });
      const original = new Message({ role: 'user', content: [imgBlock] });
      const payload = messageToAgentCorePayload(original);
      const restored = agentCorePayloadToMessage(payload);

      expect(restored.role).toBe('user');
      const restoredBlock = restored.content[0] as ImageBlock;
      expect(restoredBlock.type).toBe('imageBlock');
      expect(restoredBlock.format).toBe('jpeg');
      const restoredSource = restoredBlock.source as { bytes?: Uint8Array };
      expect(Array.from(restoredSource.bytes!)).toEqual([255, 216, 255, 224]);
    });

    // Regression: a toolResult message must restore with its INNER content as
    // SDK content-block instances (not plain objects). Otherwise, on the next
    // turn the restored history breaks both BedrockModel._formatContentBlock
    // (which switches on `content.type` → empty content → Bedrock
    // "missing field `content`") and Message.toJSON() (`block.toJSON is not a
    // function`). See content-block-codec.ts:restoreToolResultContent.
    it('toolResult message roundtrips with inner content as SDK instances', () => {
      const original = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tool-123',
            status: 'success',
            content: [new TextBlock('a.txt b.txt')],
          }),
        ],
      });

      const payload = messageToAgentCorePayload(original);
      const restored = agentCorePayloadToMessage(payload);

      const block = restored.content[0] as ToolResultBlock;
      expect(block.type).toBe('toolResultBlock');
      expect(block.toolUseId).toBe('tool-123');
      expect(block.status).toBe('success');

      // Inner content must be a real TextBlock instance (has `type` + `toJSON`).
      const inner = block.content[0] as TextBlock;
      expect(inner.type).toBe('textBlock');
      expect(inner.text).toBe('a.txt b.txt');
      expect(typeof (inner as unknown as { toJSON?: unknown }).toJSON).toBe('function');

      // The whole message must serialize without throwing (this is exactly what
      // the SDK telemetry / Bedrock request path does on the next turn).
      expect(() => restored.toJSON()).not.toThrow();
      const json = restored.toJSON() as { content: Array<{ toolResult?: { content: unknown[] } }> };
      // The Bedrock-native projection must carry the inner content (not empty).
      expect(json.content[0].toolResult?.content).toHaveLength(1);
    });

    it('assistant toolUse + following toolResult turn roundtrips and re-serializes', () => {
      // Mirrors a real tool-calling turn pair as stored/replayed across requests.
      const assistant = new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 's3_list_files', toolUseId: 't1', input: { path: '/' } })],
      });
      const toolResult = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 't1',
            status: 'success',
            content: [new TextBlock('100 files')],
          }),
        ],
      });

      for (const original of [assistant, toolResult]) {
        const restored = agentCorePayloadToMessage(messageToAgentCorePayload(original));
        expect(() => restored.toJSON()).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// extractEventId
// ---------------------------------------------------------------------------

describe('extractEventId', () => {
  it('returns the eventId when present', () => {
    expect(extractEventId({ eventId: 'evt-abc-123' })).toBe('evt-abc-123');
  });

  it('returns empty string when eventId is undefined', () => {
    expect(extractEventId({})).toBe('');
  });

  it('returns empty string when eventId is empty string', () => {
    expect(extractEventId({ eventId: '' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getCurrentTimestamp
// ---------------------------------------------------------------------------

describe('getCurrentTimestamp', () => {
  it('returns a Date instance', () => {
    expect(getCurrentTimestamp()).toBeInstanceOf(Date);
  });

  it('returns a date close to now', () => {
    const before = Date.now();
    const ts = getCurrentTimestamp();
    const after = Date.now();
    expect(ts.getTime()).toBeGreaterThanOrEqual(before);
    expect(ts.getTime()).toBeLessThanOrEqual(after);
  });
});
