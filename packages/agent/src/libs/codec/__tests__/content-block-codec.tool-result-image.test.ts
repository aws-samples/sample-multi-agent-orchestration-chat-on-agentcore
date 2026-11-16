/**
 * Codec tests for images returned by tools.
 *
 * A tool-returned image is for the model's current turn only. Every path out
 * of the agent (Memory, AppSync, the HTTP stream) goes through
 * `contentBlockToWire`, so none of them may carry its bytes — and the restored
 * history must still be a valid tool result on the next turn.
 */

import { describe, it, expect } from '@jest/globals';
import { ImageBlock, JsonBlock, TextBlock, ToolResultBlock } from '@strands-agents/sdk';
import { contentBlockToWire, wireToContentBlock } from '../content-block-codec.js';
import type { WireImageBlock, WireToolResultBlock } from '../content-block-codec.types.js';

const IMAGE_BYTES = new Uint8Array(4096).fill(7);
const IMAGE_BASE64 = Buffer.from(IMAGE_BYTES).toString('base64');

function toolResultWithImage(): ToolResultBlock {
  return new ToolResultBlock({
    toolUseId: 'tool-1',
    status: 'success',
    content: [
      new TextBlock('Image: /tmp/ws/shot.png'),
      new ImageBlock({ format: 'png', source: { bytes: IMAGE_BYTES } }),
      new JsonBlock({ json: { ok: true } }),
    ],
  });
}

describe('tool result images on the wire', () => {
  it('replaces the image with a text placeholder and keeps the other content', () => {
    const wire = contentBlockToWire(toolResultWithImage()) as WireToolResultBlock;

    expect(wire.content).toEqual([
      { text: 'Image: /tmp/ws/shot.png' },
      { text: expect.stringContaining('[image: png, 4096 bytes.') },
      { json: { ok: true } },
    ]);
    expect(JSON.stringify(wire)).not.toContain(IMAGE_BASE64);
  });

  it('leaves the live block untouched, so the model still sees the image this turn', () => {
    const block = toolResultWithImage();

    contentBlockToWire(block);

    expect(block.content[1]).toBeInstanceOf(ImageBlock);
  });

  it('restores to a tool result made of text the next turn can send', () => {
    const wire = JSON.parse(JSON.stringify(contentBlockToWire(toolResultWithImage())));

    const restored = wireToContentBlock(wire) as ToolResultBlock;

    expect(restored).toBeInstanceOf(ToolResultBlock);
    expect(restored.content.map((entry) => entry.type)).toEqual([
      'textBlock',
      'textBlock',
      'jsonBlock',
    ]);
  });

  it('still persists an image the user attached', () => {
    const wire = contentBlockToWire(
      new ImageBlock({ format: 'png', source: { bytes: IMAGE_BYTES } })
    ) as WireImageBlock;

    expect(wire.base64).toBe(IMAGE_BASE64);
  });
});
