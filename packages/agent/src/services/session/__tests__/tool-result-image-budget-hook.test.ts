/**
 * Unit tests for ToolResultImageBudgetHook.
 *
 * Tool-returned images are re-sent on every model call of a turn. The hook must
 * bound how many stay live, drop the oldest first, and leave everything else —
 * including images the user attached — alone.
 */

import { describe, it, expect } from '@jest/globals';
import {
  BeforeModelCallEvent,
  ImageBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type HookableEvent,
  type LocalAgent,
  type Model,
} from '@strands-agents/sdk';
import {
  KEPT_AFTER_PRUNE,
  MAX_LIVE_TOOL_RESULT_IMAGES,
  ToolResultImageBudgetHook,
  pruneToolResultImages,
} from '../tool-result-image-budget-hook.js';

const image = () => new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } });

/** One view_image round trip: the assistant's call and the tool result carrying image `n`. */
function viewTurn(n: number): Message[] {
  return [
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'view_image', toolUseId: `t${n}`, input: {} })],
    }),
    new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: `t${n}`,
          status: 'success',
          content: [new TextBlock(`Image: shot-${n}.png`), image()],
        }),
      ],
    }),
  ];
}

function history(images: number): Message[] {
  return [
    new Message({ role: 'user', content: [new TextBlock('compare these'), image()] }),
    ...Array.from({ length: images }, (_, n) => viewTurn(n)).flat(),
  ];
}

/** Which tool results (by index, oldest first) still hold their image. */
function liveImages(messages: Message[]): boolean[] {
  return messages
    .flatMap((message) => message.content)
    .filter((block): block is ToolResultBlock => block.type === 'toolResultBlock')
    .map((result) => result.content.some((entry) => entry.type === 'imageBlock'));
}

describe('pruneToolResultImages', () => {
  it('does nothing while the number of live images is within the limit', () => {
    const messages = history(MAX_LIVE_TOOL_RESULT_IMAGES);

    expect(pruneToolResultImages(messages)).toBe(0);
    expect(liveImages(messages).every(Boolean)).toBe(true);
  });

  it('replaces the oldest images once the limit is exceeded, keeping the newest', () => {
    const total = MAX_LIVE_TOOL_RESULT_IMAGES + 1;
    const messages = history(total);

    expect(pruneToolResultImages(messages)).toBe(total - KEPT_AFTER_PRUNE);

    const expected = Array.from({ length: total }, (_, n) => n >= total - KEPT_AFTER_PRUNE);
    expect(liveImages(messages)).toEqual(expected);
  });

  it('leaves a placeholder and the result text where an image was removed', () => {
    const messages = history(MAX_LIVE_TOOL_RESULT_IMAGES + 1);

    pruneToolResultImages(messages);

    const oldest = messages[2].content[0] as ToolResultBlock;
    expect(oldest.content).toHaveLength(2);
    expect((oldest.content[0] as TextBlock).text).toBe('Image: shot-0.png');
    expect((oldest.content[1] as TextBlock).text).toContain('[image: png, 3 bytes.');
  });

  it('never touches an image the user attached', () => {
    const messages = history(MAX_LIVE_TOOL_RESULT_IMAGES + 1);

    pruneToolResultImages(messages);

    expect(messages[0].content[1]).toBeInstanceOf(ImageBlock);
  });
});

describe('ToolResultImageBudgetHook', () => {
  it('prunes the agent messages before each model call', () => {
    let handler: ((event: HookableEvent) => void) | undefined;
    const registered: unknown[] = [];
    new ToolResultImageBudgetHook().initAgent({
      addHook: (eventType: unknown, callback: (event: HookableEvent) => void) => {
        registered.push(eventType);
        handler = callback;
        return () => {};
      },
    } as unknown as LocalAgent);
    const messages = history(MAX_LIVE_TOOL_RESULT_IMAGES + 1);

    handler!(
      new BeforeModelCallEvent({
        agent: { messages } as unknown as LocalAgent,
        model: {} as Model,
        invocationState: {} as never,
      })
    );

    expect(registered).toEqual([BeforeModelCallEvent]);
    expect(liveImages(messages).filter(Boolean)).toHaveLength(KEPT_AFTER_PRUNE);
  });
});
