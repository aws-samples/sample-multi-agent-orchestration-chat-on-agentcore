/**
 * chatStore — stopPrompt / cancellation.
 *
 * Verifies the Stop button's store contract:
 *   - sendPrompt threads an AbortSignal into streamAgentResponse;
 *   - stopPrompt(sessionId) aborts that signal, so the in-flight fetch tears
 *     down and the agent turn is cancelled;
 *   - after cancellation the session settles (isLoading false) with no error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the args streamAgentResponse is called with, and hold the promise
// open until the test releases it — mimicking an in-flight turn.
const streamAgentResponse = vi.fn();
const stopAgentTurn = vi.fn<(sessionId: string) => Promise<boolean>>();
vi.mock('../../api/agent', () => ({
  streamAgentResponse: (...args: unknown[]) => streamAgentResponse(...args),
  stopAgentTurn: (sessionId: string) => stopAgentTurn(sessionId),
}));

// Neutralise the collaborator stores sendPrompt reads via getState().
vi.mock('../agentStore', () => ({ useAgentStore: { getState: () => ({ selectedAgent: null }) } }));
vi.mock('../storageStore', () => ({
  useStorageStore: { getState: () => ({ agentWorkingDirectory: '/' }) },
}));
vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: [],
      addOptimisticSession: vi.fn(),
      refreshSessions: vi.fn(),
    }),
  },
}));
vi.mock('../memoryStore', () => ({ useMemoryStore: { getState: () => ({ isMemoryEnabled: false }) } }));
vi.mock('../settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ selectedModelId: 'm', getReasoningDepthFor: () => 'off' }),
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useChatStore } from '../chatStore';

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';

describe('chatStore stopPrompt', () => {
  beforeEach(() => {
    streamAgentResponse.mockReset();
    stopAgentTurn.mockReset();
    stopAgentTurn.mockResolvedValue(true);
    useChatStore.setState({ sessions: {}, activeSessionId: null, lastStreamCompletedAt: {} });
  });

  it('sends the out-of-band server stop command for the session', async () => {
    let release: () => void = () => {};
    streamAgentResponse.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve))
    );

    const pending = useChatStore.getState().sendPrompt('hello', SESSION_ID);
    await Promise.resolve();

    useChatStore.getState().stopPrompt(SESSION_ID);
    // The server-side stop is the only thing that actually halts the agent on
    // AgentCore, so stopPrompt MUST issue it (not just abort the local fetch).
    expect(stopAgentTurn).toHaveBeenCalledWith(SESSION_ID);

    release();
    await pending;
  });

  it('passes an AbortSignal to streamAgentResponse', async () => {
    streamAgentResponse.mockResolvedValue(undefined);

    await useChatStore.getState().sendPrompt('hello', SESSION_ID);

    const signal = streamAgentResponse.mock.calls[0][4];
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('stopPrompt aborts the in-flight signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    let release: () => void = () => {};
    streamAgentResponse.mockImplementation((...args: unknown[]) => {
      capturedSignal = args[4] as AbortSignal;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const pending = useChatStore.getState().sendPrompt('hello', SESSION_ID);
    // Let sendPrompt reach the streamAgentResponse call.
    await Promise.resolve();

    useChatStore.getState().stopPrompt(SESSION_ID);
    expect(capturedSignal?.aborted).toBe(true);

    release();
    await pending;
  });

  it('settles the session (isLoading false, no error) after stopPrompt', async () => {
    // Simulate the api layer invoking onCancel when the signal aborts.
    streamAgentResponse.mockImplementation(async (...args: unknown[]) => {
      const callbacks = args[2] as { onCancel?: () => void };
      const signal = args[4] as AbortSignal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      callbacks.onCancel?.();
    });

    const pending = useChatStore.getState().sendPrompt('hello', SESSION_ID);
    await Promise.resolve();
    useChatStore.getState().stopPrompt(SESSION_ID);
    await pending;

    const state = useChatStore.getState().sessions[SESSION_ID];
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('appends a "generation stopped" notice to the assistant message on cancel', async () => {
    streamAgentResponse.mockImplementation(async (...args: unknown[]) => {
      const callbacks = args[2] as { onCancel?: () => void };
      const signal = args[4] as AbortSignal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      callbacks.onCancel?.();
    });

    const pending = useChatStore.getState().sendPrompt('hello', SESSION_ID);
    await Promise.resolve();
    useChatStore.getState().stopPrompt(SESSION_ID);
    await pending;

    const state = useChatStore.getState().sessions[SESSION_ID];
    const assistant = state.messages.find((m) => m.type === 'assistant');
    // A visible notice must be present so the user knows the turn was stopped.
    const notice = assistant?.contents.find(
      (c) => c.type === 'text' && typeof c.text === 'string' && c.text.length > 0
    );
    expect(notice).toBeDefined();
    // Not streaming anymore, and it is not flagged as an error.
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.isError).toBeFalsy();
  });
});
