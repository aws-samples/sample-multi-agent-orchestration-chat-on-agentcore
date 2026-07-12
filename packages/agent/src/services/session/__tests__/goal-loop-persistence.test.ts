/**
 * End-to-end test for the GoalLoop × SessionPersistenceHook interaction,
 * running a REAL Agent, a REAL GoalLoop (programmatic validator — no Bedrock),
 * and the REAL SessionPersistenceHook through the SDK's actual hook dispatch.
 *
 * WHY this exists: the resume guard in SessionPersistenceHook only works
 * because the SDK dispatches After* hooks in REVERSE registration order
 * (GoalLoop registered last → its callback runs first → `event.resume` is set
 * before the persistence hook reads it). The unit tests assert array position
 * and drive callbacks manually, which would stay green if a future SDK release
 * changed dispatch order. This test pins the invariant to observed behavior:
 * a real 2-attempt goal run must produce exactly ONE AGENT_COMPLETE and must
 * not persist the intermediate attempt or the judge-feedback prompt.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { Agent, Model } from '@strands-agents/sdk';
import type { Message } from '@strands-agents/sdk';
import type { ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal';
import type { IdentityId, SessionId } from '@moca/core';
import { SessionPersistenceHook } from '../session-persistence-hook.js';
import type { SessionConfig } from '../types.js';
import type { SessionPersistenceDeps } from '../../../types/session-persistence-deps.js';

/**
 * Minimal scripted model: each stream() call emits one plain-text assistant
 * message from the queue. No network, no Bedrock.
 */
class ScriptedModel extends Model {
  private callCount = 0;
  constructor(private readonly replies: string[]) {
    super();
  }
  updateConfig(): void {}
  getConfig() {
    return { modelId: 'scripted' };
  }
  async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const text = this.replies[Math.min(this.callCount, this.replies.length - 1)];
    this.callCount++;
    yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;
    yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text },
    } as ModelStreamEvent;
    yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
    yield { type: 'modelMessageStopEvent', stopReason: 'end_turn' } as ModelStreamEvent;
  }
}

const sessionConfig: SessionConfig = {
  actorId: 'us-east-1:11111111-2222-3333-4444-555555555555' as IdentityId,
  sessionId: 'test-session' as SessionId,
  sessionType: 'user',
};

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

/** Concatenated text of a persisted message (wire or SDK block shape). */
function textOf(message: { content: Array<{ text?: string }> }): string {
  return message.content.map((b) => b.text ?? '').join('');
}

describe('GoalLoop × SessionPersistenceHook (real SDK dispatch)', () => {
  it('a 2-attempt goal run finalizes once and persists only input + final answer', async () => {
    const appendMessage = jest.fn<any>().mockResolvedValue(undefined);
    const saveMessages = jest.fn<any>().mockResolvedValue(undefined);
    const storage: any = { appendMessage, saveMessages };
    const { deps, publishMessageEvent } = makeDeps();

    // goalActive=true: buffer everything after the turn input.
    const persistenceHook = new SessionPersistenceHook(
      storage,
      sessionConfig,
      deps,
      undefined,
      undefined,
      true
    );

    // Programmatic validator: fail attempt 1, pass attempt 2. Mirrors the
    // production wiring minus the Bedrock judge (createAgent uses a NL goal,
    // but the After-hook mechanics — resume, dispatch order — are identical).
    let attempts = 0;
    const goalLoop = new GoalLoop({
      goal: () => {
        attempts++;
        return attempts >= 2 || { passed: false, feedback: 'try harder' };
      },
      maxAttempts: 3,
      timeout: 120_000,
    });

    // Same ordering as createAgent: persistence hook BEFORE GoalLoop, GoalLoop
    // LAST — the property under test.
    const agent = new Agent({
      model: new ScriptedModel(['first (bad) answer', 'final answer']),
      printer: false,
      plugins: [persistenceHook, goalLoop],
    });

    const result = await agent.invoke('turn input');

    // The goal loop genuinely retried once and then passed.
    expect(goalLoop.lastResult(agent)).toMatchObject({
      passed: true,
      stopReason: 'satisfied',
    });
    expect(goalLoop.lastResult(agent)?.attempts).toHaveLength(2);
    expect(String(result)).toContain('final answer');

    // Exactly ONE AGENT_COMPLETE — the LIFO dispatch let GoalLoop set
    // event.resume before the persistence hook read it on attempt 1.
    const eventTypes = publishMessageEvent.mock.calls.map((c: any[]) => c[2]?.type);
    expect(eventTypes.filter((t: string) => t === 'AGENT_COMPLETE')).toHaveLength(1);

    // Persisted transcript = [turn input, final answer]. No intermediate
    // attempt, no synthetic judge-feedback prompt.
    const persistedTexts = appendMessage.mock.calls.map((c: any[]) => textOf(c[1]));
    expect(persistedTexts).toEqual(['turn input', 'final answer']);
    expect(persistedTexts.join('\n')).not.toContain('first (bad) answer');
    expect(persistedTexts.join('\n')).not.toContain('previous attempt');

    // The whole-history fallback must not run on goal turns (agent.messages
    // still holds all attempts and would re-leak them).
    expect(saveMessages).not.toHaveBeenCalled();
  });
});
