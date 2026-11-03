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

/** @returns A function that stops the renewal loop. */
export function startAgentTokenRenewal(sessionId: string): () => void {
  const timer = setInterval(() => {
    renewAgentTokens(sessionId).catch((err) => {
      logger.warn('[agent-token-renewal] renewal failed; retrying next interval:', err);
    });
  }, TOKEN_RENEWAL_INTERVAL_MS);
  return () => clearInterval(timer);
}
