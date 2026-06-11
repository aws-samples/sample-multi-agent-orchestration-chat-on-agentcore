/**
 * Unit tests for stream-serializer.ts
 *
 * The critical contract these tests pin: SDK 1.x ContentBlock class
 * instances embedded in stream events MUST be normalised through the
 * codec so the wire NDJSON line preserves `block.type`. Without this,
 * the frontend's `switch (block.type)` silently drops tool results
 * during streaming and the user only sees them after a full reload.
 */

import { describe, it, expect } from '@jest/globals';
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '@strands-agents/sdk';

import { serializeStreamEvent } from '../stream-serializer.js';

describe('serializeStreamEvent', () => {
  describe('messageAddedEvent', () => {
    it('preserves block.type for assistant messages with toolUseBlock content', () => {
      const message = new Message({
        role: 'assistant',
        content: [
          new TextBlock('Calling tool'),
          new ToolUseBlock({
            name: 'calc',
            toolUseId: 'tu-1',
            input: { expr: '1+1' },
          }),
        ],
      });

      const [serialised] = serializeStreamEvent({
        type: 'messageAddedEvent',
        message,
      }) as Array<{
        type: string;
        message: { role: string; content: Array<{ type: string }> };
      }>;

      // The frontend's `switch (block.type)` must match — without the
      // codec normalisation it would silently drop toolUseBlock content.
      expect(serialised.type).toBe('messageAddedEvent');
      expect(serialised.message.role).toBe('assistant');
      expect(serialised.message.content[0].type).toBe('textBlock');
      expect(serialised.message.content[1].type).toBe('toolUseBlock');
    });

    it('preserves block.type for user messages with toolResultBlock content', () => {
      const message = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tu-1',
            status: 'success',
            content: [new TextBlock('tool output')],
          }),
        ],
      });

      const [serialised] = serializeStreamEvent({
        type: 'messageAddedEvent',
        message,
      }) as Array<{
        type: string;
        message: { role: string; content: Array<{ type: string; toolUseId: string }> };
      }>;

      expect(serialised.message.content[0].type).toBe('toolResultBlock');
      expect(serialised.message.content[0].toolUseId).toBe('tu-1');
    });

    it('survives JSON.stringify without losing block.type (regression: SDK toJSON drops type)', () => {
      // This is the canary: passing a ContentBlock instance directly to
      // JSON.stringify invokes SDK toJSON() which drops `type`. The
      // serializer must defuse that by normalising first.
      const message = new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({
            name: 'fetchUrl',
            toolUseId: 'tu-2',
            input: { url: 'https://example.com' },
          }),
        ],
      });

      const [serialised] = serializeStreamEvent({
        type: 'messageAddedEvent',
        message,
      });

      // Round-trip through JSON to mimic res.write(JSON.stringify(...))
      const wire = JSON.parse(JSON.stringify(serialised)) as {
        message: { content: Array<{ type?: string; name?: string }> };
      };
      expect(wire.message.content[0].type).toBe('toolUseBlock');
      expect(wire.message.content[0].name).toBe('fetchUrl');
    });
  });

  describe('afterToolsEvent', () => {
    it('forwards message.content with normalised block.type', () => {
      const message = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tu-3',
            status: 'success',
            content: [new TextBlock('after-tools result')],
          }),
        ],
      });

      const [serialised] = serializeStreamEvent({
        type: 'afterToolsEvent',
        message,
      }) as Array<{
        type: string;
        message: { content: Array<{ type: string }> };
      }>;

      expect(serialised.type).toBe('afterToolsEvent');
      expect(serialised.message.content[0].type).toBe('toolResultBlock');
    });
  });

  describe('toolResultEvent (SDK 1.x)', () => {
    it('normalises a ToolResultBlock instance carried in event.result', () => {
      const result = new ToolResultBlock({
        toolUseId: 'tu-4',
        status: 'success',
        content: [new TextBlock('single result')],
      });

      const [serialised] = serializeStreamEvent({
        type: 'toolResultEvent',
        result,
      }) as Array<{ type: string; result: { type: string; toolUseId: string } }>;

      expect(serialised.type).toBe('toolResultEvent');
      expect(serialised.result.type).toBe('toolResultBlock');
      expect(serialised.result.toolUseId).toBe('tu-4');
    });
  });

  describe('contentBlockEvent (SDK 1.x)', () => {
    it('normalises a ContentBlock instance carried in event.contentBlock', () => {
      const contentBlock = new TextBlock('hello');

      const [serialised] = serializeStreamEvent({
        type: 'contentBlockEvent',
        contentBlock,
      }) as Array<{ type: string; contentBlock: { type: string; text: string } }>;

      expect(serialised.contentBlock.type).toBe('textBlock');
      expect(serialised.contentBlock.text).toBe('hello');
    });
  });

  describe('modelStreamUpdateEvent unwrap (SDK 1.x)', () => {
    it('forwards the inner legacy modelContentBlockDeltaEvent untouched', () => {
      const inner = {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'streaming…' },
      };
      const out = serializeStreamEvent({
        type: 'modelStreamUpdateEvent',
        event: inner,
      });
      expect(out).toHaveLength(1);
      expect((out[0] as { type: string }).type).toBe('modelContentBlockDeltaEvent');
      expect((out[0] as { delta: unknown }).delta).toEqual(inner.delta);
    });
  });

  describe('reasoningContentDelta', () => {
    it('forwards reasoning text + signature untouched', () => {
      const [out] = serializeStreamEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'thinking…', signature: 'sig' },
      }) as Array<{ delta: Record<string, unknown> }>;
      expect(out.delta).toEqual({
        type: 'reasoningContentDelta',
        text: 'thinking…',
        signature: 'sig',
      });
    });

    it('base64-encodes a redactedContent Uint8Array and drops the raw field', () => {
      const bytes = new Uint8Array([1, 2, 3, 250]);
      const [out] = serializeStreamEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', redactedContent: bytes },
      }) as Array<{ delta: Record<string, unknown> }>;
      expect(out.delta.redactedContent).toBeUndefined();
      expect(out.delta.redactedContentBase64).toBe(Buffer.from(bytes).toString('base64'));
      // The serialized line must be valid JSON (no Uint8Array corruption).
      expect(() => JSON.stringify(out)).not.toThrow();
    });
  });
});
