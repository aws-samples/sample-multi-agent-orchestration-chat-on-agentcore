/**
 * Unit tests for ReasoningHistoryStripHook.
 *
 * Sonnet 5.5 thinking blocks are prefix-bound: replaying one after the system
 * prompt / tools / earlier messages changed returns a 400. The hook must drop
 * reasoning from completed prior turns before each invocation, only for models
 * flagged `stripPriorReasoning`, and never empty an assistant message.
 */

import { describe, it, expect } from '@jest/globals';
import {
  Message,
  TextBlock,
  ReasoningBlock,
  ToolUseBlock,
  BeforeInvocationEvent,
  type LocalAgent,
  type HookableEvent,
} from '@strands-agents/sdk';
import {
  ReasoningHistoryStripHook,
  stripReasoningBlocks,
} from '../reasoning-history-strip-hook.js';

type Handler = (event: HookableEvent) => void;

function register(hook: ReasoningHistoryStripHook): Handler | undefined {
  let handler: Handler | undefined;
  const fakeAgent = {
    addHook: (_eventType: unknown, callback: Handler) => {
      handler = callback;
      return () => {};
    },
  } as unknown as LocalAgent;
  hook.initAgent(fakeAgent);
  return handler;
}

function fire(handler: Handler, messages: Message[]): void {
  handler(
    new BeforeInvocationEvent({
      agent: { messages } as unknown as LocalAgent,
      invocationState: {} as never,
    })
  );
}

function history(): Message[] {
  return [
    new Message({ role: 'user', content: [new TextBlock('hi')] }),
    new Message({
      role: 'assistant',
      content: [
        new ReasoningBlock({ text: 'plan', signature: 'sig1' }),
        new ToolUseBlock({ name: 'think', toolUseId: 't1', input: {} }),
      ],
    }),
    new Message({
      role: 'assistant',
      content: [
        new ReasoningBlock({ text: 'progress', signature: 'sig2' }),
        new TextBlock('answer'),
      ],
    }),
  ];
}

describe('ReasoningHistoryStripHook', () => {
  it('strips prior-turn reasoning for Sonnet 5.5', () => {
    const handler = register(new ReasoningHistoryStripHook('global.anthropic.claude-sonnet-5-5'));
    expect(handler).toBeDefined();
    const messages = history();
    fire(handler!, messages);
    for (const m of messages) {
      expect(m.content.some((b) => b.type === 'reasoningBlock')).toBe(false);
    }
    expect(messages[1].content.map((b) => b.type)).toEqual(['toolUseBlock']);
    expect(messages[2].content.map((b) => b.type)).toEqual(['textBlock']);
  });

  it.each([
    'global.anthropic.claude-opus-5',
    'global.anthropic.claude-opus-5-5',
    'global.anthropic.claude-sonnet-5',
    'global.anthropic.claude-fable-5',
  ])('does not register for %s', (modelId) => {
    expect(register(new ReasoningHistoryStripHook(modelId))).toBeUndefined();
  });

  it('never leaves an assistant message with empty content', () => {
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ReasoningBlock({ text: 'only', signature: 's' })],
      }),
    ];
    expect(stripReasoningBlocks(messages)).toBe(0);
    expect(messages[0].content).toHaveLength(1);
  });

  it('ignores user messages and returns the removed count', () => {
    expect(stripReasoningBlocks(history())).toBe(2);
    expect(stripReasoningBlocks([])).toBe(0);
  });
});
