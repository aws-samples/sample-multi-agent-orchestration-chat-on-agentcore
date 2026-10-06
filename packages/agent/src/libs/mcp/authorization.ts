/**
 * User-delegated OAuth (Authorization Code / 3LO) support for Gateway tools.
 *
 * When a 3LO target has no token for the user yet, the Gateway answers
 * `tools/call` with JSON-RPC error -32042 carrying a URL elicitation. The URL
 * is delivered to the frontend out-of-band (stream event) and never to the
 * model, so prompt-injected content cannot pose as the authorization link.
 * See docs/adr/gateway-3lo-github.md.
 */

import { getCurrentContext } from '../context/request-context.js';

/** MCP 2025-11-25 "URL elicitation required" error code. */
export const MCP_URL_ELICITATION_REQUIRED = -32042;

/** Gateway composes tool names as `{targetName}___{toolName}`. */
export const TARGET_TOOL_SEPARATOR = '___';

export interface AuthorizationRequest {
  /** AgentCore Identity authorization URL the user must open */
  url: string;
  elicitationId: string;
  /** Gateway target name (e.g. "github") */
  targetName: string;
}

/** Fixed tool result returned to the model instead of the URL. */
export const AUTHORIZATION_PENDING_TOOL_RESULT =
  'Authorization required: the user has not connected this external service yet. ' +
  'An authorization prompt is now shown in the user interface. ' +
  'Ask the user to complete it and then repeat the request. ' +
  'Do not provide or invent any authorization link yourself.';

export function targetNameOf(toolName: string): string {
  const index = toolName.indexOf(TARGET_TOOL_SEPARATOR);
  return index === -1 ? toolName : toolName.slice(0, index);
}

/**
 * Only AgentCore Identity's authorize endpoint in this region is accepted, so a
 * compromised or misconfigured target cannot route users to an arbitrary page.
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

/**
 * Extract the URL elicitation from a -32042 JSON-RPC error.
 */
export function parseUrlElicitation(
  error: { code: number; data?: unknown },
  toolName: string,
  region: string
): AuthorizationRequest | undefined {
  if (error.code !== MCP_URL_ELICITATION_REQUIRED) return undefined;
  const elicitations = (error.data as { elicitations?: unknown } | undefined)?.elicitations;
  if (!Array.isArray(elicitations)) return undefined;

  for (const elicitation of elicitations) {
    const { mode, url, elicitationId } = (elicitation ?? {}) as Record<string, unknown>;
    if (
      mode === 'url' &&
      typeof url === 'string' &&
      typeof elicitationId === 'string' &&
      isTrustedAuthorizationUrl(url, region)
    ) {
      return { url, elicitationId, targetName: targetNameOf(toolName) };
    }
  }
  return undefined;
}

/**
 * Returned instead when no prompt can be shown (sub-agent / non-interactive run),
 * so the model does not point the user at a UI element that never appears.
 */
export const AUTHORIZATION_UNAVAILABLE_TOOL_RESULT =
  'Authorization required: the user has not connected this external service yet, ' +
  'and it cannot be connected from this context (sub-agent or non-interactive run). ' +
  'Ask the user to make this request directly in the chat to connect the service. ' +
  'Do not provide or invent any authorization link yourself.';

/**
 * Queue an authorization request for the stream handler to emit.
 * @returns whether the prompt will reach the user
 */
export function queueAuthorizationRequest(request: AuthorizationRequest): boolean {
  const context = getCurrentContext();
  if (!context?.surfacesAuthorizationPrompts) return false;
  context.pendingAuthorizations = [...(context.pendingAuthorizations ?? []), request];
  return true;
}

/**
 * Take all queued authorization requests (de-duplicated per target).
 */
export function drainAuthorizationRequests(): AuthorizationRequest[] {
  const context = getCurrentContext();
  const pending = context?.pendingAuthorizations ?? [];
  if (context) context.pendingAuthorizations = undefined;
  const byTarget = new Map(pending.map((request) => [request.targetName, request]));
  return [...byTarget.values()];
}

/**
 * Tools of user-delegated targets need a human's own account, so they are
 * hidden from machine-user (trigger) invocations.
 */
export function isUserDelegatedTool(toolName: string, targets: string[]): boolean {
  return targets.some((target) => toolName.startsWith(`${target}${TARGET_TOOL_SEPARATOR}`));
}
