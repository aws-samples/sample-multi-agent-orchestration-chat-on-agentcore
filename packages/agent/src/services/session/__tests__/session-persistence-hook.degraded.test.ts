/**
 * Message persistence after credentials can no longer be refreshed (AC-3):
 * one warning event for the turn, not one log line per message.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { Message, TextBlock, MessageAddedEvent } from '@strands-agents/sdk';

const hookLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  createLogger: () => hookLog,
  logger: hookLog,
}));

const { SessionPersistenceHook } = await import('../session-persistence-hook.js');
const { createRequestContext, runWithContext } =
  await import('../../../libs/context/request-context.js');

describe('SessionPersistenceHook when credentials expired', () => {
  it('surfaces one persistenceDegraded event for many failed message saves', async () => {
    const expired = Object.assign(
      new Error('The security token included in the request is expired'),
      {
        name: 'ExpiredTokenException',
      }
    );
    const storage = { appendMessage: jest.fn<() => Promise<void>>().mockRejectedValue(expired) };
    const hook = new SessionPersistenceHook(
      storage as never,
      { actorId: 'a', sessionId: 's' } as never,
      {
        getSessionsService: () => ({ isConfigured: () => false }) as never,
        getTitleGenerator: () => ({}) as never,
        publishMessageEvent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) as never,
      }
    );
    const handlers: Array<(e: unknown) => Promise<void>> = [];
    hook.initAgent({
      addHook: (type: unknown, fn: (e: unknown) => Promise<void>) => {
        if (type === MessageAddedEvent) handlers.push(fn);
      },
    } as never);

    const ctx = createRequestContext('Bearer at');
    const events: unknown[] = [];
    ctx.emitClientEvent = (e) => events.push(e);

    await runWithContext(ctx, async () => {
      for (let i = 0; i < 3; i++) {
        const message = new Message({ role: 'assistant', content: [new TextBlock(`m${i}`)] });
        await handlers[0]({ message });
      }
    });

    expect(events).toHaveLength(1);
    expect(hookLog.warn).not.toHaveBeenCalled();
    expect(hookLog.error).toHaveBeenCalledTimes(1);
  });
});
