/**
 * Unit tests for SessionPersistenceHook — the GoalLoop resume guard and the
 * goal-turn buffering.
 *
 * GoalLoop retries by setting `AfterInvocationEvent.resume` (an InvokeArgs) so
 * the agent re-enters its loop. AfterInvocationEvent fires once PER ATTEMPT, so
 * the hook must NOT finalize (saveMessages + AGENT_COMPLETE) on intermediate
 * attempts — only on the terminal attempt where `resume === undefined`.
 *
 * When goalActive, real-time egress is buffered: intermediate failed attempts
 * and the synthetic judge-feedback user prompts must never reach Memory /
 * AppSync; only [turn input + final attempt] may. These tests drive the
 * registered callbacks directly against a minimal fake agent.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  AfterInvocationEvent,
  MessageAddedEvent,
  type LocalAgent,
  type HookableEvent,
} from '@strands-agents/sdk';
import type { IdentityId, SessionId } from '@moca/core';
import { SessionPersistenceHook } from '../session-persistence-hook.js';
import type { SessionConfig } from '../types.js';
import type { SessionPersistenceDeps } from '../../../types/session-persistence-deps.js';

type Handler = (event: HookableEvent) => void | Promise<void>;

const sessionConfig: SessionConfig = {
  actorId: 'us-east-1:11111111-2222-3333-4444-555555555555' as IdentityId,
  sessionId: 'test-session' as SessionId,
  sessionType: 'user',
};

/** Build deps whose SessionsService is unconfigured (isolates the guard from DynamoDB). */
function makeDeps(): { deps: SessionPersistenceDeps; publishMessageEvent: jest.Mock } {
  const publishMessageEvent = jest.fn<any>().mockResolvedValue(undefined);
  const deps: SessionPersistenceDeps = {
    getSessionsService: () => ({
      isConfigured: () => false,
      sessionExists: jest.fn<any>(),
      createSession: jest.fn<any>(),
      updateSessionAgentAndStorage: jest.fn<any>(),
      updateSessionTimestamp: jest.fn<any>(),
      updateSessionTitle: jest.fn<any>(),
    }),
    getTitleGenerator: () => ({ generateTitle: jest.fn<any>() }),
    publishMessageEvent,
  };
  return { deps, publishMessageEvent };
}

/** Capture both callbacks the hook registers. */
function captureHandlers(hook: SessionPersistenceHook): {
  onMessageAdded: Handler;
  onAfterInvocation: Handler;
} {
  let messageAdded: Handler | undefined;
  let afterInvocation: Handler | undefined;
  const fakeAgent = {
    addHook: (eventType: unknown, callback: Handler) => {
      if (eventType === AfterInvocationEvent) afterInvocation = callback;
      if (eventType === MessageAddedEvent) messageAdded = callback;
      return () => {};
    },
  } as unknown as LocalAgent;

  hook.initAgent(fakeAgent);
  if (!messageAdded || !afterInvocation) {
    throw new Error('Hook did not register both callbacks');
  }
  return { onMessageAdded: messageAdded, onAfterInvocation: afterInvocation };
}

/** Capture the AfterInvocationEvent callback the hook registers. */
function captureAfterInvocation(hook: SessionPersistenceHook): Handler {
  return captureHandlers(hook).onAfterInvocation;
}

/** An AfterInvocationEvent carrying `messages`, with `resume` optionally set. */
function makeAfterEvent(resume: unknown): AfterInvocationEvent {
  const agent = { messages: [{ role: 'user' }, { role: 'assistant' }] } as unknown as LocalAgent;
  const event = new AfterInvocationEvent({ agent, invocationState: {} as never });
  (event as { resume: unknown }).resume = resume;
  return event;
}

/** A MessageAddedEvent for a simple text message. */
function makeMessageEvent(role: 'user' | 'assistant', text: string): MessageAddedEvent {
  return new MessageAddedEvent({
    agent: {} as unknown as LocalAgent,
    message: { role, content: [{ type: 'textBlock', text }] } as never,
    invocationState: {} as never,
  });
}

describe('SessionPersistenceHook onAfterInvocation resume guard', () => {
  let saveMessages: jest.Mock;
  let storage: any;

  beforeEach(() => {
    saveMessages = jest.fn<any>().mockResolvedValue(undefined);
    storage = { appendMessage: jest.fn<any>().mockResolvedValue(undefined), saveMessages };
  });

  it('finalizes (saveMessages + AGENT_COMPLETE) when resume is undefined (terminal attempt)', async () => {
    const { deps, publishMessageEvent } = makeDeps();
    const hook = new SessionPersistenceHook(storage, sessionConfig, deps);
    const handler = captureAfterInvocation(hook);

    await handler(makeAfterEvent(undefined));

    expect(saveMessages).toHaveBeenCalledTimes(1);
    const completeCalls = publishMessageEvent.mock.calls.filter(
      (c: any[]) => c[2]?.type === 'AGENT_COMPLETE'
    );
    expect(completeCalls).toHaveLength(1);
  });

  it('skips finalize when resume is set (intermediate GoalLoop attempt)', async () => {
    const { deps, publishMessageEvent } = makeDeps();
    const hook = new SessionPersistenceHook(storage, sessionConfig, deps);
    const handler = captureAfterInvocation(hook);

    // resume is InvokeArgs — a non-undefined object triggers a retry.
    await handler(makeAfterEvent({ input: 'refine with feedback' }));

    expect(saveMessages).not.toHaveBeenCalled();
    const completeCalls = publishMessageEvent.mock.calls.filter(
      (c: any[]) => c[2]?.type === 'AGENT_COMPLETE'
    );
    expect(completeCalls).toHaveLength(0);
  });

  it('does not treat a falsy-but-defined resume as terminal (guards with !== undefined)', async () => {
    // Defensive: an empty-string resume is still "resuming". The guard must use
    // `!== undefined`, not a truthiness check, or this would wrongly finalize.
    const { deps } = makeDeps();
    const hook = new SessionPersistenceHook(storage, sessionConfig, deps);
    const handler = captureAfterInvocation(hook);

    await handler(makeAfterEvent(''));

    expect(saveMessages).not.toHaveBeenCalled();
  });
});

describe('SessionPersistenceHook goal-turn buffering (goalActive)', () => {
  let appendMessage: jest.Mock;
  let saveMessages: jest.Mock;
  let storage: any;

  /** Text of every message that reached real-time persistence, in order. */
  const persistedTexts = () =>
    appendMessage.mock.calls.map((c: any[]) => c[1]?.content?.[0]?.text);

  const makeGoalHook = (deps: SessionPersistenceDeps) =>
    new SessionPersistenceHook(storage, sessionConfig, deps, undefined, undefined, true);

  beforeEach(() => {
    appendMessage = jest.fn<any>().mockResolvedValue(undefined);
    saveMessages = jest.fn<any>().mockResolvedValue(undefined);
    storage = { appendMessage, saveMessages };
  });

  it('persists only [turn input + final attempt] across a 3-attempt goal run', async () => {
    const { deps, publishMessageEvent } = makeDeps();
    const { onMessageAdded, onAfterInvocation } = captureHandlers(makeGoalHook(deps));

    // Attempt 1: user input (real-time) + failed assistant answer (buffered).
    await onMessageAdded(makeMessageEvent('user', 'turn input'));
    await onMessageAdded(makeMessageEvent('assistant', 'attempt 1 (failed)'));
    await onAfterInvocation(makeAfterEvent({ input: 'feedback 1' })); // resume armed

    // Attempt 2: synthetic feedback user message (skipped) + failed answer.
    await onMessageAdded(makeMessageEvent('user', 'judge feedback 1'));
    await onMessageAdded(makeMessageEvent('assistant', 'attempt 2 (failed)'));
    await onAfterInvocation(makeAfterEvent({ input: 'feedback 2' }));

    // Attempt 3: feedback (skipped) + passing answer, then terminal After.
    await onMessageAdded(makeMessageEvent('user', 'judge feedback 2'));
    await onMessageAdded(makeMessageEvent('assistant', 'final answer'));
    await onAfterInvocation(makeAfterEvent(undefined));

    // Only the user's own input and the final attempt reached persistence —
    // no intermediate answers, no judge-feedback prompts.
    expect(persistedTexts()).toEqual(['turn input', 'final answer']);

    // MESSAGE_ADDED published for exactly those two; AGENT_COMPLETE exactly once.
    const published = publishMessageEvent.mock.calls.map((c: any[]) => c[2]?.type);
    expect(published.filter((t: string) => t === 'MESSAGE_ADDED')).toHaveLength(2);
    expect(published.filter((t: string) => t === 'AGENT_COMPLETE')).toHaveLength(1);

    // The whole-history fallback must NOT run on goal turns: agent.messages
    // still contains all attempts and would re-leak them.
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it('flushes the buffered answer on a first-attempt pass', async () => {
    const { deps, publishMessageEvent } = makeDeps();
    const { onMessageAdded, onAfterInvocation } = captureHandlers(makeGoalHook(deps));

    await onMessageAdded(makeMessageEvent('user', 'turn input'));
    await onMessageAdded(makeMessageEvent('assistant', 'answer'));
    await onAfterInvocation(makeAfterEvent(undefined));

    expect(persistedTexts()).toEqual(['turn input', 'answer']);
    const published = publishMessageEvent.mock.calls.map((c: any[]) => c[2]?.type);
    expect(published.filter((t: string) => t === 'AGENT_COMPLETE')).toHaveLength(1);
  });

  it('buffers tool-use pairs of the final attempt and flushes them in order', async () => {
    const { deps } = makeDeps();
    const { onMessageAdded, onAfterInvocation } = captureHandlers(makeGoalHook(deps));

    await onMessageAdded(makeMessageEvent('user', 'turn input'));
    // Failed attempt 1 with a tool round-trip — all discarded.
    await onMessageAdded(makeMessageEvent('assistant', 'tool call 1'));
    await onMessageAdded(makeMessageEvent('user', 'tool result 1'));
    await onMessageAdded(makeMessageEvent('assistant', 'attempt 1 (failed)'));
    await onAfterInvocation(makeAfterEvent({ input: 'feedback' }));
    // Final attempt with its own tool round-trip — all flushed.
    await onMessageAdded(makeMessageEvent('user', 'judge feedback'));
    await onMessageAdded(makeMessageEvent('assistant', 'tool call 2'));
    await onMessageAdded(makeMessageEvent('user', 'tool result 2'));
    await onMessageAdded(makeMessageEvent('assistant', 'final answer'));
    await onAfterInvocation(makeAfterEvent(undefined));

    expect(persistedTexts()).toEqual([
      'turn input',
      'tool call 2',
      'tool result 2',
      'final answer',
    ]);
  });

  it('does not buffer when goalActive is false (default real-time path)', async () => {
    const { deps } = makeDeps();
    const hook = new SessionPersistenceHook(storage, sessionConfig, deps);
    const { onMessageAdded } = captureHandlers(hook);

    await onMessageAdded(makeMessageEvent('user', 'input'));
    await onMessageAdded(makeMessageEvent('assistant', 'answer'));

    expect(persistedTexts()).toEqual(['input', 'answer']);
  });
});
