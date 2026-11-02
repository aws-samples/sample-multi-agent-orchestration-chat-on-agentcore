/**
 * Gateway user-delegated OAuth (Authorization Code / 3LO) helpers.
 * See docs/adr/gateway-3lo-github.md.
 */

export type { AuthorizationPrompt } from '../types/index';

/** BroadcastChannel used by /oauth/callback to tell chat tabs a flow completed. */
export const OAUTH_BROADCAST_CHANNEL = 'moca-oauth';

/**
 * Only AgentCore Identity's authorize endpoint is rendered as a link. The
 * agent already filters, but the UI is the last line before a user clicks.
 */
export function isTrustedAuthorizationUrl(url: string, region: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === `bedrock-agentcore.${region}.amazonaws.com` &&
      parsed.pathname.startsWith('/identities/')
    );
  } catch {
    return false;
  }
}

/** Display name for a Gateway target. */
export function serviceNameOf(targetName: string): string {
  return targetName === 'github' ? 'GitHub' : targetName;
}

/**
 * The callback opens in a new tab (noopener), so the originating chat is
 * handed over via localStorage. Only `/chat/<id>` paths are honoured to keep
 * the callback from becoming an open redirect.
 */
const OAUTH_RETURN_PATH_KEY = 'moca-oauth-return-path';
const RETURN_PATH_PATTERN = /^\/chat\/[A-Za-z0-9_-]+$/;

export function rememberOAuthReturnPath(sessionId: string): void {
  const path = `/chat/${sessionId}`;
  if (RETURN_PATH_PATTERN.test(path)) localStorage.setItem(OAUTH_RETURN_PATH_KEY, path);
}

export function takeOAuthReturnPath(): string {
  const path = localStorage.getItem(OAUTH_RETURN_PATH_KEY);
  localStorage.removeItem(OAUTH_RETURN_PATH_KEY);
  return path && RETURN_PATH_PATTERN.test(path) ? path : '/chat';
}
