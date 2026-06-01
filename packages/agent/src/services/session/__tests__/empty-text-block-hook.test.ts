/**
 * Unit tests for EmptyTextBlockHook.
 *
 * Reproduces the Qwen3 failure mode: an assistant message whose first content
 * block is an empty TextBlock emitted before a toolUse block. The follow-up
 * Bedrock request rejects the blank text field, so the hook must strip it.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  Message,
  TextBlock,
  ToolUseBlock,
  MessageAddedEvent,
  type LocalAgent,
  type HookableEvent,
} from '@strands-agents/sdk';
import { EmptyTextBlockHook } from '../empty-text-block-hook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (event: HookableEvent) => void;

/**
 * Register the hook against a minimal fake agent and return the captured
 * MessageAddedEvent callback so tests can drive it directly.
 */
function captureHandler(hook: EmptyTextBlockHook): Handler {
  let handler: Handler | undefined;
  const fakeAgent = {
    addHook: (_eventType: unknown, callback: Handler) => {
      handler = callback;
      return () => {};
    },
  } as unknown as LocalAgent;

  hook.initAgent(fakeAgent);
  if (!handler) {
    throw new Error('Hook did not register a MessageAddedEvent callback');
  }
  return handler;
}

function fire(handler: Handler, message: Message): void {
  handler(
    new MessageAddedEvent({
      // The hook only reads `event.message`; agent/invocationState are unused.
      agent: {} as unknown as LocalAgent,
      message,
      invocationState: {} as never,
    })
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmptyTextBlockHook', () => {
  it('strips a leading empty TextBlock that precedes a toolUse block (Qwen3 case)', () => {
    const handler = captureHandler(new EmptyTextBlockHook());
    const toolUse = new ToolUseBlock({ name: 'list_files', toolUseId: 'tu_1', input: { path: '.' } });
    const message = new Message({ role: 'assistant', content: [new TextBlock(''), toolUse] });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toBe(toolUse);
  });

  it('also strips whitespace-only TextBlocks', () => {
    const handler = captureHandler(new EmptyTextBlockHook());
    const toolUse = new ToolUseBlock({ name: 't', toolUseId: 'tu_2', input: {} });
    const message = new Message({ role: 'assistant', content: [new TextBlock('   \n'), toolUse] });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toBe(toolUse);
  });

  it('preserves non-empty TextBlocks', () => {
    const handler = captureHandler(new EmptyTextBlockHook());
    const text = new TextBlock('Here are your files:');
    const toolUse = new ToolUseBlock({ name: 't', toolUseId: 'tu_3', input: {} });
    const message = new Message({ role: 'assistant', content: [text, toolUse] });

    fire(handler, message);

    expect(message.content).toHaveLength(2);
    expect(message.content[0]).toBe(text);
  });

  it('does not empty out a message made up solely of empty TextBlocks', () => {
    const handler = captureHandler(new EmptyTextBlockHook());
    const message = new Message({ role: 'assistant', content: [new TextBlock(''), new TextBlock('')] });

    fire(handler, message);

    // Never produce empty `content` — Bedrock rejects that too.
    expect(message.content.length).toBeGreaterThan(0);
  });

  it('ignores user messages', () => {
    const handler = captureHandler(new EmptyTextBlockHook());
    const message = new Message({ role: 'user', content: [new TextBlock('')] });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
  });

  it('is a no-op for a normal assistant text message (Claude case)', () => {
    const handler = captureHandler(new EmptyTextBlockHook());
    const text = new TextBlock('All done.');
    const message = new Message({ role: 'assistant', content: [text] });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toBe(text);
  });

  it('registers a callback during initAgent', () => {
    const hook = new EmptyTextBlockHook();
    const addHook = jest.fn(() => () => {});
    hook.initAgent({ addHook } as unknown as LocalAgent);
    expect(addHook).toHaveBeenCalledTimes(1);
  });
});
