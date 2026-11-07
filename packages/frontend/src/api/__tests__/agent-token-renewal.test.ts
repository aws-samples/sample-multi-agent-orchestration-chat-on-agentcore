/**
 * Token renewal for a running agent turn (AC-1, AC-7).
 *
 * While a turn runs, the frontend periodically re-sends refreshed Cognito
 * tokens to the same Runtime session so the agent can keep re-minting
 * user-scoped credentials and calling the Backend after the 1 h token life.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { authService } from '../../lib/auth';
import {
  renewAgentTokens,
  startAgentTokenRenewal,
  TOKEN_RENEWAL_INTERVAL_MS,
  MIN_RENEWAL_GAP_MS,
} from '../agent-token-renewal';

vi.mock('../client/agent-client', () => ({ agentClient: { invoke: vi.fn() } }));
vi.mock('../../lib/auth', () => ({ authService: { getTokens: vi.fn() } }));

const SESSION = 'S'.repeat(33);
const MIN = 60_000;

function tokensExpiringIn(ms: number) {
  return { accessToken: 'at', idToken: 'id', userId: 'u', expiresAt: Date.now() + ms };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(agentClient.invoke).mockResolvedValue({ ok: true } as Response);
  vi.mocked(authService.getTokens).mockResolvedValue(tokensExpiringIn(50 * MIN) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('renewAgentTokens', () => {
  it('sends a renewTokens action on the same Runtime session', async () => {
    await renewAgentTokens(SESSION);

    const [options] = vi.mocked(agentClient.invoke).mock.calls[0];
    expect(JSON.parse(options!.body as string)).toEqual({ action: 'renewTokens' });
    expect(
      (options!.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']
    ).toBe(SESSION);
  });

  it('forces a token refresh first when the current tokens are close to expiry', async () => {
    vi.mocked(authService.getTokens).mockResolvedValueOnce(tokensExpiringIn(5 * MIN) as never);

    await renewAgentTokens(SESSION);

    expect(authService.getTokens).toHaveBeenCalledWith({ forceRefresh: true });
  });
});

describe('startAgentTokenRenewal', () => {
  it('renews on an interval until stopped', async () => {
    const stop = startAgentTokenRenewal(SESSION);

    await vi.advanceTimersByTimeAsync(TOKEN_RENEWAL_INTERVAL_MS * 2);
    expect(agentClient.invoke).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(TOKEN_RENEWAL_INTERVAL_MS * 2);
    expect(agentClient.invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps renewing after a failed attempt', async () => {
    vi.mocked(agentClient.invoke).mockRejectedValueOnce(new Error('network'));
    const stop = startAgentTokenRenewal(SESSION);

    await vi.advanceTimersByTimeAsync(TOKEN_RENEWAL_INTERVAL_MS * 2);
    expect(agentClient.invoke).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('startAgentTokenRenewal wake-up triggers', () => {
  // iOS PWAs stop JS timers in the background, and a reload drops the
  // streaming fetch with its timer, so the interval alone can miss the whole
  // token lifetime.
  let visible = true;
  let doc: EventTarget;
  let win: EventTarget;
  const wake = () => ({ document: doc, window: win, isVisible: () => visible });

  beforeEach(() => {
    visible = true;
    doc = new EventTarget();
    win = new EventTarget();
  });

  it('renews right away when asked to (reattach after reload / dropped stream)', async () => {
    const stop = startAgentTokenRenewal(SESSION, { immediate: true, wake: wake() });
    await vi.advanceTimersByTimeAsync(0);
    expect(agentClient.invoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each([
    ['visibilitychange', 'document'],
    ['pageshow', 'window'],
    ['online', 'window'],
  ] as const)('renews when the page wakes up (%s)', async (eventName, on) => {
    const stop = startAgentTokenRenewal(SESSION, { wake: wake() });
    await vi.advanceTimersByTimeAsync(MIN_RENEWAL_GAP_MS + 1);
    (on === 'document' ? doc : win).dispatchEvent(new Event(eventName));
    await vi.advanceTimersByTimeAsync(0);
    expect(agentClient.invoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores becoming hidden and throttles bursts of wake-ups', async () => {
    const stop = startAgentTokenRenewal(SESSION, { immediate: true, wake: wake() });
    await vi.advanceTimersByTimeAsync(0);

    visible = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    visible = true;
    win.dispatchEvent(new Event('pageshow'));
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(agentClient.invoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops listening once stopped', async () => {
    const stop = startAgentTokenRenewal(SESSION, { wake: wake() });
    stop();
    await vi.advanceTimersByTimeAsync(MIN_RENEWAL_GAP_MS + 1);
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(agentClient.invoke).not.toHaveBeenCalled();
  });
});
