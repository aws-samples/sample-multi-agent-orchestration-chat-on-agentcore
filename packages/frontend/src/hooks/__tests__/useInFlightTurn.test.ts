// @vitest-environment jsdom
/**
 * A turn running server-side that this tab is not streaming gets token
 * renewal from here — unless a machine runs it on its own runtime session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SessionSummary } from '../../api/sessions';

const stopRenewal = vi.fn();
const startAgentTokenRenewal = vi.fn<(sessionId: string, options?: unknown) => () => void>(
  () => stopRenewal
);
vi.mock('../../api/agent-token-renewal', () => ({
  startAgentTokenRenewal: (sessionId: string, options?: unknown) =>
    startAgentTokenRenewal(sessionId, options),
}));

const { useInFlightTurn } = await import('../useInFlightTurn');
const { useSessionStore } = await import('../../stores/sessionStore');

const SESSION = 'S'.repeat(33);

function seed(runner: 'user' | 'machine'): void {
  const now = new Date().toISOString();
  useSessionStore.setState({
    sessions: [
      {
        sessionId: SESSION,
        title: 't',
        createdAt: now,
        updatedAt: now,
        activeTurnStartedAt: now,
        activeTurnRunner: runner,
      } as SessionSummary,
    ],
  });
}

beforeEach(() => vi.clearAllMocks());

describe('useInFlightTurn', () => {
  it('renews tokens for a running user turn', () => {
    seed('user');
    renderHook(() => useInFlightTurn(SESSION));
    expect(startAgentTokenRenewal).toHaveBeenCalledWith(SESSION, { immediate: true });
  });

  it('does not renew tokens for a running machine turn', () => {
    seed('machine');
    renderHook(() => useInFlightTurn(SESSION));
    expect(startAgentTokenRenewal).not.toHaveBeenCalled();
  });
});
