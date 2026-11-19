/**
 * A dropped stream (`network error`) while the turn keeps running
 * server-side: the failed message must stop being "streaming", otherwise the
 * tab believes it is still streaming and neither reattaches (running state,
 * token renewal) nor accepts AppSync messages until a reload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';
import { useSessionStore } from '../sessionStore';
import { streamAgentResponse } from '../../api/agent';
import { StreamDisconnectedError } from '../../utils/stream-idle-watchdog';

vi.mock('../../api/agent', () => ({ streamAgentResponse: vi.fn() }));

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';

beforeEach(() => {
  useChatStore.setState({ sessions: {}, activeSessionId: SESSION_ID, lastStreamCompletedAt: {} });
  useSessionStore.setState({ sessions: [] });
  vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
    callbacks.onError?.(new Error('network error'));
  });
});

describe('chatStore stream error', () => {
  it('ends the streaming flag and keeps the error text on the assistant message', async () => {
    await useChatStore.getState().sendPrompt('build it', SESSION_ID);

    const state = useChatStore.getState().sessions[SESSION_ID]!;
    expect(state.messages.some((m) => m.isStreaming)).toBe(false);
    const assistant = state.messages.find((m) => m.type === 'assistant')!;
    expect(assistant.isError).toBe(true);
    expect(JSON.stringify(assistant.contents)).toContain('network error');
    expect(state.isLoading).toBe(false);
  });

  it('re-reads the session list so a turn still running server-side is detected', async () => {
    const refresh = vi.spyOn(useSessionStore.getState(), 'refreshSessions').mockResolvedValue();

    await useChatStore.getState().sendPrompt('build it', SESSION_ID);

    expect(refresh).toHaveBeenCalled();
  });
});

describe('chatStore model stopped by a safety filter', () => {
  it('marks the reply as stopped and tells the user why, instead of a silent truncated reasoning', async () => {
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onReasoningDelta?.('I still need to check');
      callbacks.onWarning?.({
        code: 'modelStopped',
        stopReason: 'contentFiltered',
        message: 'stopped',
      } as never);
      callbacks.onComplete?.({});
    });

    await useChatStore.getState().sendPrompt('analyse', SESSION_ID);

    const assistant = useChatStore
      .getState()
      .sessions[SESSION_ID]!.messages.find((m) => m.type === 'assistant')!;
    expect(assistant.isError).toBe(true);
    const texts = assistant.contents.filter((c) => c.type === 'text').map((c) => c.text ?? '');
    expect(texts.join('')).toContain('contentFiltered');
  });
});

describe('chatStore stream disconnected without a verdict (#157)', () => {
  const disconnect = () =>
    vi.mocked(streamAgentResponse).mockImplementation(async (_p, _s, callbacks) => {
      callbacks.onError?.(new StreamDisconnectedError(new TypeError('Load failed')));
    });
  const assistant = () =>
    useChatStore.getState().sessions[SESSION_ID]!.messages.find((m) => m.type === 'assistant')!;
  const settle = () => vi.waitFor(() => expect(resync).toHaveBeenCalled());
  let resync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disconnect();
    useSessionStore.setState({ activeSessionId: SESSION_ID, sessionEvents: [] });
    resync = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({
      resyncSessionEvents: resync,
      refreshSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('keeps showing a turn that is still running server-side, without an error flash', async () => {
    useSessionStore.setState({
      sessions: [
        {
          sessionId: SESSION_ID,
          title: 't',
          createdAt: '',
          updatedAt: new Date().toISOString(),
          activeTurnStartedAt: new Date().toISOString(),
        },
      ],
    } as never);

    await useChatStore.getState().sendPrompt('build it', SESSION_ID);
    await settle();

    const state = useChatStore.getState().sessions[SESSION_ID]!;
    expect(assistant().isError).toBeFalsy();
    expect(assistant().isStreaming).toBe(false);
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(true);
  });

  it('shows no error when the turn finished while away and history has the prompt', async () => {
    resync.mockImplementation(async () => {
      useSessionStore.setState({
        sessionEvents: [
          { id: 'e1', type: 'user', contents: [{ type: 'text', text: 'build it' }], timestamp: '' },
          {
            id: 'e2',
            type: 'assistant',
            contents: [{ type: 'text', text: 'done' }],
            timestamp: '',
          },
        ],
      } as never);
    });

    await useChatStore.getState().sendPrompt('build it', SESSION_ID);
    await settle();
    await vi.waitFor(() =>
      expect(useChatStore.getState().sessions[SESSION_ID]!.isLoading).toBe(false)
    );

    expect(assistant().isError).toBeFalsy();
    expect(useChatStore.getState().sessions[SESSION_ID]!.error).toBeNull();
  });

  it('reports the error when nothing is running and the prompt never reached the runtime', async () => {
    await useChatStore.getState().sendPrompt('build it', SESSION_ID);
    await settle();
    await vi.waitFor(() => expect(assistant().isError).toBe(true));

    expect(JSON.stringify(assistant().contents)).toContain('Load failed');
    expect(useChatStore.getState().sessions[SESSION_ID]!.isLoading).toBe(false);
  });
});
