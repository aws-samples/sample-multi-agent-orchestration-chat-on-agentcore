/**
 * Unit tests for SessionPersistenceHook.onAfterInvocation — specifically the
 * GoalLoop resume guard.
 *
 * GoalLoop retries by setting `AfterInvocationEvent.resume` (an InvokeArgs) so
 * the agent re-enters its loop. AfterInvocationEvent fires once PER ATTEMPT, so
 * the hook must NOT finalize (saveMessages + AGENT_COMPLETE) on intermediate
 * attempts — only on the terminal attempt where `resume === undefined`. These
 * tests drive the AfterInvocationEvent callback directly against a minimal fake
 * agent.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AfterInvocationEvent, type LocalAgent, type HookableEvent } from '@strands-agents/sdk';
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

/** Capture the AfterInvocationEvent callback the hook registers. */
function captureAfterInvocation(hook: SessionPersistenceHook): Handler {
  let handler: Handler | undefined;
  const fakeAgent = {
    addHook: (eventType: unknown, callback: Handler) => {
      // Only capture the AfterInvocationEvent handler; ignore MessageAddedEvent.
      if (eventType === AfterInvocationEvent) handler = callback;
      return () => {};
    },
  } as unknown as LocalAgent;

  hook.initAgent(fakeAgent);
  if (!handler) throw new Error('Hook did not register an AfterInvocationEvent callback');
  return handler;
}

/** An AfterInvocationEvent carrying `messages`, with `resume` optionally set. */
function makeAfterEvent(resume: unknown): AfterInvocationEvent {
  const agent = { messages: [{ role: 'user' }, { role: 'assistant' }] } as unknown as LocalAgent;
  const event = new AfterInvocationEvent({ agent, invocationState: {} as never });
  (event as { resume: unknown }).resume = resume;
  return event;
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
