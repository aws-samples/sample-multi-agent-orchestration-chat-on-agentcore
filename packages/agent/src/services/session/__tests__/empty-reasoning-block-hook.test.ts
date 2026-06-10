/**
 * Unit tests for EmptyReasoningBlockHook.
 *
 * Reproduces the Fable 5 failure mode: an assistant message carrying a
 * reasoning block whose `text` is the empty string (signature only, no
 * redactedContent). On the next turn the SDK BedrockModel formatter rejects it
 * with "reasoning content format incorrect. Either 'text' or 'redactedContent'
 * must be set.", so the hook must strip it before it re-enters history.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  Message,
  TextBlock,
  ReasoningBlock,
  MessageAddedEvent,
  type LocalAgent,
  type HookableEvent,
} from '@strands-agents/sdk';
import { EmptyReasoningBlockHook } from '../empty-reasoning-block-hook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (event: HookableEvent) => void;

function captureHandler(hook: EmptyReasoningBlockHook): Handler {
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
      agent: {} as unknown as LocalAgent,
      message,
      invocationState: {} as never,
    })
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmptyReasoningBlockHook', () => {
  it('strips an empty-text reasoning block that precedes the answer (Fable 5 case)', () => {
    const handler = captureHandler(new EmptyReasoningBlockHook());
    // Fable 5 shape: reasoning with text '' + a signature, then the real answer.
    const reasoning = new ReasoningBlock({ text: '', signature: 'CAIS-sig' });
    const text = new TextBlock('17 × 23 = 391');
    const message = new Message({ role: 'assistant', content: [reasoning, text] });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toBe(text);
  });

  it('preserves a reasoning block that has non-empty text', () => {
    const handler = captureHandler(new EmptyReasoningBlockHook());
    const reasoning = new ReasoningBlock({ text: 'Let me think: 17×23…', signature: 'sig' });
    const text = new TextBlock('391');
    const message = new Message({ role: 'assistant', content: [reasoning, text] });

    fire(handler, message);

    expect(message.content).toHaveLength(2);
    expect(message.content[0]).toBe(reasoning);
  });

  it('preserves a reasoning block carrying redactedContent (no text)', () => {
    const handler = captureHandler(new EmptyReasoningBlockHook());
    const reasoning = new ReasoningBlock({ redactedContent: new Uint8Array([1, 2, 3]) });
    const text = new TextBlock('answer');
    const message = new Message({ role: 'assistant', content: [reasoning, text] });

    fire(handler, message);

    expect(message.content).toHaveLength(2);
    expect(message.content[0]).toBe(reasoning);
  });

  it('does not empty out a message made up solely of empty reasoning blocks', () => {
    const handler = captureHandler(new EmptyReasoningBlockHook());
    const message = new Message({
      role: 'assistant',
      content: [new ReasoningBlock({ text: '', signature: 's1' })],
    });

    fire(handler, message);

    // Never produce empty `content` — Bedrock rejects that too.
    expect(message.content.length).toBeGreaterThan(0);
  });

  it('ignores user messages', () => {
    const handler = captureHandler(new EmptyReasoningBlockHook());
    const message = new Message({
      role: 'user',
      content: [new TextBlock('hello')],
    });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
  });

  it('is a no-op for a normal assistant text message (Opus case)', () => {
    const handler = captureHandler(new EmptyReasoningBlockHook());
    const text = new TextBlock('All done.');
    const message = new Message({ role: 'assistant', content: [text] });

    fire(handler, message);

    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toBe(text);
  });

  it('registers a callback during initAgent', () => {
    const hook = new EmptyReasoningBlockHook();
    const addHook = jest.fn(() => () => {});
    hook.initAgent({ addHook } as unknown as LocalAgent);
    expect(addHook).toHaveBeenCalledTimes(1);
  });
});
