/**
 * chatStore.sendPrompt — per-message goal passthrough.
 *
 * Verifies that a goal (and its judge model) supplied to sendPrompt reaches the
 * agentConfig handed to streamAgentResponse, and that a goal-less send carries
 * neither field. streamAgentResponse is mocked so we capture the config without
 * hitting the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamAgentResponse } from '../../api/agent';
import type { AgentConfig } from '../../api/agent';
import { useChatStore } from '../chatStore';
import { useSettingsStore } from '../settingsStore';

vi.mock('../../api/agent', () => ({
  streamAgentResponse: vi.fn(),
}));

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';

/** The agentConfig (4th positional arg) captured from the last stream call. */
function capturedAgentConfig(): AgentConfig | undefined {
  const call = vi.mocked(streamAgentResponse).mock.calls.at(-1);
  return call?.[3];
}

describe('chatStore.sendPrompt goal passthrough', () => {
  beforeEach(() => {
    // Default mock: resolve immediately by invoking onComplete so sendPrompt returns.
    vi.mocked(streamAgentResponse).mockReset();
    vi.mocked(streamAgentResponse).mockImplementation(async (_prompt, _sessionId, callbacks) => {
      callbacks.onComplete?.({});
    });
    useChatStore.setState({ sessions: {}, activeSessionId: null, lastStreamCompletedAt: {} });
    useSettingsStore.setState({ selectedModelId: 'global.anthropic.claude-opus-4-8' });
  });

  it('onGoalRetry resets the streaming bubble so only the final attempt remains', async () => {
    // Simulate a 2-attempt goal turn: attempt-1 text streams, the retry
    // boundary fires, then the final attempt streams. Without the reset the
    // bubble would render 'attempt 1 (bad)final answer' live while history
    // keeps only the final answer — content silently changing on reload.
    vi.mocked(streamAgentResponse).mockImplementation(async (_prompt, _sessionId, callbacks) => {
      callbacks.onTextDelta?.('attempt 1 (bad)');
      callbacks.onGoalRetry?.();
      callbacks.onTextDelta?.('final answer');
      callbacks.onComplete?.({
        goalResult: { passed: true, stopReason: 'satisfied', attempts: 2 },
      });
    });

    await useChatStore.getState().sendPrompt('hello', SESSION_ID, undefined, 'Be concise');

    const messages = useChatStore.getState().sessions[SESSION_ID].messages;
    const assistant = messages.find((m) => m.type === 'assistant');
    const text = assistant?.contents.map((c) => c.text ?? '').join('');
    expect(text).toBe('final answer');
    expect(text).not.toContain('attempt 1');
    expect(assistant?.goalResult?.attempts).toBe(2);
  });

  it('onGoalRetry also discards buffered tool blocks from the failed attempt', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_prompt, _sessionId, callbacks) => {
      callbacks.onTextDelta?.('calling tool');
      callbacks.onToolUse?.({ id: 't1', name: 'calc', input: {}, status: 'running' });
      callbacks.onGoalRetry?.();
      callbacks.onTextDelta?.('final answer');
      callbacks.onComplete?.({});
    });

    await useChatStore.getState().sendPrompt('hello', SESSION_ID, undefined, 'Be concise');

    const assistant = useChatStore
      .getState()
      .sessions[SESSION_ID].messages.find((m) => m.type === 'assistant');
    expect(assistant?.contents).toHaveLength(1);
    expect(assistant?.contents[0].text).toBe('final answer');
  });

  it('passes goal and goalJudgeModelId into agentConfig', async () => {
    await useChatStore
      .getState()
      .sendPrompt('hello', SESSION_ID, undefined, 'Be concise', 'global.anthropic.claude-haiku-4-5-20251001-v1:0');

    const config = capturedAgentConfig();
    expect(config?.goal).toBe('Be concise');
    expect(config?.goalJudgeModelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('passes goalMaxAttempts into agentConfig alongside the goal', async () => {
    await useChatStore
      .getState()
      .sendPrompt('hello', SESSION_ID, undefined, 'Be concise', undefined, 5);

    const config = capturedAgentConfig();
    expect(config?.goal).toBe('Be concise');
    expect(config?.goalMaxAttempts).toBe(5);
  });

  it('drops goalMaxAttempts when the goal is absent', async () => {
    await useChatStore.getState().sendPrompt('hello', SESSION_ID, undefined, undefined, undefined, 5);

    const config = capturedAgentConfig();
    expect(config?.goal).toBeUndefined();
    expect(config?.goalMaxAttempts).toBeUndefined();
  });

  it('trims the goal and drops the judge model when the goal is whitespace-only', async () => {
    await useChatStore
      .getState()
      .sendPrompt('hello', SESSION_ID, undefined, '   ', 'global.anthropic.claude-haiku-4-5-20251001-v1:0');

    const config = capturedAgentConfig();
    expect(config?.goal).toBeUndefined();
    expect(config?.goalJudgeModelId).toBeUndefined();
  });

  it('sends neither goal nor judge model on a goal-less send', async () => {
    await useChatStore.getState().sendPrompt('hello', SESSION_ID);

    const config = capturedAgentConfig();
    expect(config?.goal).toBeUndefined();
    expect(config?.goalJudgeModelId).toBeUndefined();
  });

  it('drops the judge model when a goal is absent even if a judge id is passed', async () => {
    await useChatStore
      .getState()
      .sendPrompt('hello', SESSION_ID, undefined, undefined, 'global.anthropic.claude-haiku-4-5-20251001-v1:0');

    const config = capturedAgentConfig();
    expect(config?.goal).toBeUndefined();
    expect(config?.goalJudgeModelId).toBeUndefined();
  });
});
