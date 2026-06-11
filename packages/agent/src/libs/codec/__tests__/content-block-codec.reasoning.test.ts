/**
 * Codec unit tests for the reasoningBlock structured wire shape.
 *
 * The critical regression these guard: `ReasoningBlock.redactedContent` is a
 * Uint8Array. The old passthrough spread JSON-corrupted it; the structured wire
 * shape must round-trip text + signature AND redactedContent (as base64)
 * byte-for-byte, so a reasoning block restored from AgentCore Memory is re-sent
 * to Bedrock without "reasoning content format incorrect".
 */

import { describe, it, expect } from '@jest/globals';
import { ReasoningBlock } from '@strands-agents/sdk';
import { contentBlockToWire, wireToContentBlock } from '../content-block-codec.js';
import type { WireReasoningBlock } from '../content-block-codec.types.js';

describe('reasoningBlock codec round-trip', () => {
  it('preserves text + signature through SDK → wire → JSON → wire → SDK', () => {
    const block = new ReasoningBlock({ text: 'Let me think...', signature: 'CAISabc123' });

    const wire = contentBlockToWire(block) as WireReasoningBlock;
    expect(wire).toEqual({
      type: 'reasoningBlock',
      text: 'Let me think...',
      signature: 'CAISabc123',
    });

    // Simulate Memory persistence: serialize and parse.
    const restored = wireToContentBlock(JSON.parse(JSON.stringify(wire)));
    expect(restored.type).toBe('reasoningBlock');
    const r = restored as ReasoningBlock;
    expect(r.text).toBe('Let me think...');
    expect(r.signature).toBe('CAISabc123');
    expect(r).toBeInstanceOf(ReasoningBlock);
  });

  it('preserves redactedContent bytes exactly across base64 round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 42, 13, 10]);
    const block = new ReasoningBlock({ redactedContent: bytes });

    const wire = contentBlockToWire(block) as WireReasoningBlock;
    expect(wire.type).toBe('reasoningBlock');
    expect(typeof wire.redactedContentBase64).toBe('string');
    // text/signature absent — should not be emitted.
    expect(wire.text).toBeUndefined();
    expect(wire.signature).toBeUndefined();

    const restored = wireToContentBlock(JSON.parse(JSON.stringify(wire))) as ReasoningBlock;
    expect(restored.redactedContent).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored.redactedContent!)).toEqual(Array.from(bytes));
  });

  it('does not emit redactedContentBase64 for an empty redactedContent', () => {
    const block = new ReasoningBlock({ text: 'hi', redactedContent: new Uint8Array() });
    const wire = contentBlockToWire(block) as WireReasoningBlock;
    expect(wire.redactedContentBase64).toBeUndefined();
  });

  it('round-trips a block that carries both text/signature and redactedContent', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const block = new ReasoningBlock({ text: 'reasoned', signature: 'sig', redactedContent: bytes });

    const restored = wireToContentBlock(
      JSON.parse(JSON.stringify(contentBlockToWire(block)))
    ) as ReasoningBlock;

    expect(restored.text).toBe('reasoned');
    expect(restored.signature).toBe('sig');
    expect(Array.from(restored.redactedContent!)).toEqual([9, 8, 7]);
  });
});
