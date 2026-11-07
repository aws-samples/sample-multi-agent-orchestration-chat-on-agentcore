/**
 * The session row carries an "active turn" marker so a reloaded UI can show
 * that the turn is still running and keep Send disabled (AC-6).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { Message, TextBlock, MessageAddedEvent, AfterInvocationEvent } from '@strands-agents/sdk';

const noop = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  createLogger: () => noop,
  logger: noop,
}));

const { SessionPersistenceHook } = await import('../session-persistence-hook.js');
const { createRequestContext, runWithContext } =
  await import('../../../libs/context/request-context.js');

function setup(sessionExists: boolean) {
  const sessionsService = {
    isConfigured: () => true,
    sessionExists: jest.fn<() => Promise<boolean>>().mockResolvedValue(sessionExists),
    createSession: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
    updateSessionAgentAndStorage: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateSessionTimestamp: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateSessionTitle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setActiveTurn: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const hook = new SessionPersistenceHook(
    {
      appendMessage: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      saveMessages: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as never,
    { actorId: 'actor', sessionId: 'sess' } as never,
    {
      getSessionsService: () => sessionsService as never,
      getTitleGenerator: () => ({ generateTitle: async () => 't' }) as never,
      publishMessageEvent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) as never,
    }
  );
  const handlers = new Map<unknown, (e: unknown) => Promise<void>>();
  hook.initAgent({
    addHook: (type: unknown, fn: (e: unknown) => Promise<void>) => handlers.set(type, fn),
  } as never);
  return { sessionsService, handlers };
}

describe.each([
  ['new session', false],
  ['existing session', true],
])('SessionPersistenceHook active-turn marker (%s)', (_label, exists) => {
  it('marks the turn running on the first user message and clears it after the invocation', async () => {
    const { sessionsService, handlers } = setup(exists);
    const ctx = createRequestContext('Bearer at');

    await runWithContext(ctx, async () => {
      await handlers.get(MessageAddedEvent)!({
        message: new Message({ role: 'user', content: [new TextBlock('build it')] }),
      });
      expect(sessionsService.setActiveTurn).toHaveBeenCalledWith(
        'actor',
        'sess',
        ctx.startTime.toISOString()
      );

      await handlers.get(AfterInvocationEvent)!({ agent: { messages: [] } });
    });

    expect(sessionsService.setActiveTurn).toHaveBeenLastCalledWith('actor', 'sess', undefined);
  });
});
