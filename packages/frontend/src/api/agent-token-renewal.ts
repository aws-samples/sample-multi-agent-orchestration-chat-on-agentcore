/**
 * Keep a running agent turn supplied with fresh Cognito tokens.
 *
 * Cognito ID / access tokens live 1 h, but a turn can run for hours. The
 * Runtime re-mints the user's Identity Pool credentials (and calls the
 * Backend) with the freshest token it has seen for the session, so while a
 * turn is in flight we re-send ours on the same Runtime session — AgentCore
 * routes it to the same microVM, where it is acknowledged without starting a
 * new turn. Only run this while a turn is known to be in flight: a renewal on
 * an idle session would start a fresh microVM.
 */

import { agentClient } from './client/agent-client';
import { authService } from '../lib/auth';
import { logger } from '../utils/logger';

export const TOKEN_RENEWAL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Larger than the interval, so the token the Runtime holds always has at
 * least one interval of validity left when it needs to refresh credentials.
 */
const REFRESH_AHEAD_MS = 2 * TOKEN_RENEWAL_INTERVAL_MS;

export async function renewAgentTokens(sessionId: string): Promise<void> {
  const tokens = await authService.getTokens();
  if (tokens.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
    await authService.getTokens({ forceRefresh: true });
  }

  const response = await agentClient.invoke({
    method: 'POST',
    headers: { 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId },
    body: JSON.stringify({ action: 'renewTokens' }),
  });
  if (!response.ok) {
    throw new Error(`Token renewal failed: HTTP ${response.status}`);
  }
}

/** Wake-ups closer together than this send one renewal. */
export const MIN_RENEWAL_GAP_MS = 60 * 1000;

interface WakeSources {
  document?: EventTarget;
  window?: EventTarget;
  isVisible: () => boolean;
}

function browserWakeSources(): WakeSources {
  return {
    document: typeof document !== 'undefined' ? document : undefined,
    window: typeof window !== 'undefined' ? window : undefined,
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  };
}

/**
 * Renew on an interval, and also whenever the page wakes up: iOS PWAs stop JS
 * timers in the background, so after the user returns the interval alone may
 * not fire until the token has already expired.
 *
 * @param options.immediate Renew right away (reattaching after a reload or a
 *   dropped stream; the streaming request itself already carries fresh tokens).
 * @returns A function that stops the renewal loop.
 */
export function startAgentTokenRenewal(
  sessionId: string,
  options: { immediate?: boolean; wake?: WakeSources } = {}
): () => void {
  const wake = options.wake ?? browserWakeSources();
  let lastSentAt = Number.NEGATIVE_INFINITY;

  const renew = (): void => {
    lastSentAt = Date.now();
    renewAgentTokens(sessionId).catch((err) => {
      logger.warn('[agent-token-renewal] renewal failed; retrying later:', err);
    });
  };
  const onWake = (): void => {
    if (!wake.isVisible() || Date.now() - lastSentAt < MIN_RENEWAL_GAP_MS) return;
    renew();
  };

  const timer = setInterval(renew, TOKEN_RENEWAL_INTERVAL_MS);
  wake.document?.addEventListener('visibilitychange', onWake);
  wake.window?.addEventListener('pageshow', onWake);
  wake.window?.addEventListener('online', onWake);
  if (options.immediate) renew();

  return () => {
    clearInterval(timer);
    wake.document?.removeEventListener('visibilitychange', onWake);
    wake.window?.removeEventListener('pageshow', onWake);
    wake.window?.removeEventListener('online', onWake);
  };
}
