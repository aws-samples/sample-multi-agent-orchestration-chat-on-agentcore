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
