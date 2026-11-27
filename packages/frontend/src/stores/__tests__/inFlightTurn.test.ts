/**
 * Reattaching to a turn that is still running server-side (AC-6): after a
 * reload the chat must show the running state and keep Send disabled
 * (isLoading) until the runtime reports the turn finished.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../sessionStore';
import { useChatStore } from '../chatStore';
import { applySessionEvent } from '../../hooks/useSessionEventsSubscription';

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';

beforeEach(() => {
  useSessionStore.setState({ sessions: [] });
  useChatStore.setState({ sessions: {} });
  useSessionStore.getState().addOptimisticSession(SESSION_ID, 'long build', 'user');
});

describe('session active-turn marker', () => {
  it('MODIFY events set and clear activeTurnStartedAt', () => {
    applySessionEvent({
      type: 'MODIFY',
      sessionId: SESSION_ID,
      turnActive: true,
      activeTurnStartedAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:30:00.000Z',
    });
    const running = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(running?.activeTurnStartedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(running?.updatedAt).toBe('2026-11-01T00:30:00.000Z');

    applySessionEvent({ type: 'MODIFY', sessionId: SESSION_ID, turnActive: false });
    const idle = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(idle?.activeTurnStartedAt).toBeUndefined();
  });

  it('MODIFY events carry the turn runner and the rescued runtime session kind', async () => {
    const { runtimeSessionIdFor } = await import('../../api/runtime-session');
    applySessionEvent({
      type: 'MODIFY',
      sessionId: SESSION_ID,
      turnActive: true,
      activeTurnStartedAt: '2026-11-01T00:00:00.000Z',
      activeTurnRunner: 'machine',
      userRuntimeSessionKind: 'rescued',
    });
    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID);
    expect(session?.activeTurnRunner).toBe('machine');
    expect(runtimeSessionIdFor(SESSION_ID)).toBe(`${SESSION_ID}u`);

    applySessionEvent({ type: 'MODIFY', sessionId: SESSION_ID, turnActive: false });
    expect(
      useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID)?.activeTurnRunner
    ).toBeUndefined();
  });

  it('events from a stream handler that predates the marker leave it untouched', () => {
    useSessionStore.getState().updateSessionActiveTurn(SESSION_ID, '2026-11-01T00:00:00.000Z');
    applySessionEvent({ type: 'MODIFY', sessionId: SESSION_ID, title: 'renamed' });
    expect(
      useSessionStore.getState().sessions.find((s) => s.sessionId === SESSION_ID)
        ?.activeTurnStartedAt
    ).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('chatStore.setRemoteTurnRunning', () => {
  it('shows a remotely running turn as loading and clears it when it ends', () => {
    const chat = useChatStore.getState();
    chat.setRemoteTurnRunning(SESSION_ID, true);
    expect(useChatStore.getState().sessions[SESSION_ID]?.isLoading).toBe(true);

    chat.setRemoteTurnRunning(SESSION_ID, false);
    expect(useChatStore.getState().sessions[SESSION_ID]?.isLoading).toBe(false);
  });

  it('does not end the loading state of a turn this tab is streaming', () => {
    const chat = useChatStore.getState();
    chat.setLoading(SESSION_ID, true);
    chat.addMessage(SESSION_ID, { type: 'assistant', contents: [], isStreaming: true });

    chat.setRemoteTurnRunning(SESSION_ID, false);

    expect(useChatStore.getState().sessions[SESSION_ID]?.isLoading).toBe(true);
  });
});

describe('chatStore.loadSessionHistory', () => {
  const history = [
    {
      id: 'ev-1',
      type: 'user' as const,
      contents: [{ type: 'text' as const, text: 'build it' }],
      timestamp: '2026-11-01T00:00:00.000Z',
    },
  ];

  it('keeps the running state set before the history response landed (#157)', () => {
    const chat = useChatStore.getState();
    chat.switchSession(SESSION_ID);
    chat.setRemoteTurnRunning(SESSION_ID, true);

    chat.loadSessionHistory(SESSION_ID, history);

    const state = useChatStore.getState().sessions[SESSION_ID];
    expect(state?.isLoading).toBe(true);
    expect(state?.messages.map((m) => m.id)).toEqual(['ev-1']);
  });

  it('does not replace a reply this tab is streaming', () => {
    const chat = useChatStore.getState();
    chat.addMessage(SESSION_ID, { type: 'assistant', contents: [], isStreaming: true });

    chat.loadSessionHistory(SESSION_ID, history);

    const messages = useChatStore.getState().sessions[SESSION_ID]?.messages;
    expect(messages).toHaveLength(1);
    expect(messages?.[0].isStreaming).toBe(true);
  });
});
