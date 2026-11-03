/**
 * Keep the chat in sync with a turn running server-side that this tab is not
 * streaming — typically after a reload or when the PWA was backgrounded,
 * because AgentCore keeps the turn running when the client stream drops.
 *
 * While such a turn runs: show the running state (isLoading disables Send and
 * renders the TypingIndicator; messages arrive via AppSync), and keep the
 * turn supplied with fresh tokens so it can keep saving past the 1 h token
 * lifetime.
 */

import { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useChatStore } from '../stores/chatStore';
import { isTurnRunning, TURN_STALE_AFTER_MS } from '../utils/turn-status';
import { startAgentTokenRenewal } from '../api/agent-token-renewal';

export function useInFlightTurn(sessionId: string | null): void {
  const session = useSessionStore((state) =>
    sessionId ? state.sessions.find((s) => s.sessionId === sessionId) : undefined
  );
  const streamingHere = useChatStore((state) =>
    sessionId ? !!state.sessions[sessionId]?.messages.some((msg) => msg.isStreaming) : false
  );

  // Re-evaluate staleness periodically even when no event arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TURN_STALE_AFTER_MS / 3);
    return () => clearInterval(timer);
  }, []);

  const locallyCompletedAt = useChatStore((state) =>
    sessionId ? state.lastStreamCompletedAt?.[sessionId] : undefined
  );

  const running = isTurnRunning(session, now, locallyCompletedAt);

  useEffect(() => {
    if (!sessionId || streamingHere) return;
    useChatStore.getState().setRemoteTurnRunning(sessionId, running);
    // The streaming tab renews tokens itself (streamAgentResponse).
    if (!running) return;
    return startAgentTokenRenewal(sessionId);
  }, [sessionId, running, streamingHere]);
}
