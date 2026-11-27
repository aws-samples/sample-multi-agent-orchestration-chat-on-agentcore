/**
 * Which AgentCore Runtime session a human reaches a conversation through.
 *
 * On Runtime V2 a runtime session is pinned to its first caller, for good: the
 * pin survives StopRuntimeSession and the idle timeout (verified on dev). Before
 * runtime session ids were split from conversation ids, automation (triggers,
 * workflows) used the plain conversation id, so for those conversations the
 * plain id is pinned to the machine user and humans get 403. They continue on
 * the `rescued` runtime session instead (see `toRuntimeSessionId`).
 *
 * The agent records a rescued conversation on its session row, so other devices
 * start on the right id; this module only falls back to a single 403 retry for
 * a conversation nobody has rescued yet.
 */

import { isSessionId, toRuntimeSessionId } from '@moca/core';
import { agentClient } from './client/agent-client';
import { logger } from '../utils/logger';

export const RUNTIME_SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

/** Rescued in this tab, before the session row says so. */
const rescued = new Set<string>();
let isRescuedOnRow: (sessionId: string) => boolean = () => false;

/** The session store answers from the session rows (list load and stream events). */
export function registerRescuedLookup(lookup: (sessionId: string) => boolean): void {
  isRescuedOnRow = lookup;
}

export function runtimeSessionIdFor(sessionId: string): string {
  const isRescued = rescued.has(sessionId) || isRescuedOnRow(sessionId);
  if (!isRescued || !isSessionId(sessionId)) return sessionId;
  return toRuntimeSessionId(sessionId, 'rescued');
}

/** The platform's own 403 for a runtime session pinned to someone else; it never reaches the container. */
function isPinnedToAnotherIdentity(response: Response): boolean {
  return (
    response.status === 403 &&
    (response.headers.get('x-amzn-ErrorType') ?? '').startsWith('AccessDeniedException')
  );
}

/**
 * POST to the Runtime on the caller's runtime session for `sessionId`,
 * retrying once on the rescued runtime session when the plain one is pinned
 * to another identity.
 */
export async function invokeOnRuntimeSession(
  sessionId: string,
  init: RequestInit
): Promise<Response> {
  const send = (runtimeSessionId: string) =>
    agentClient.invoke({
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        [RUNTIME_SESSION_HEADER]: runtimeSessionId,
      },
    });

  const runtimeSessionId = runtimeSessionIdFor(sessionId);
  const response = await send(runtimeSessionId);
  if (
    runtimeSessionId !== sessionId ||
    !isSessionId(sessionId) ||
    !isPinnedToAnotherIdentity(response)
  ) {
    return response;
  }

  logger.warn('[runtime-session] runtime session pinned to another identity; retrying rescued');
  await response.body?.cancel().catch(() => {});
  const retry = await send(toRuntimeSessionId(sessionId, 'rescued'));
  // Only once it worked: a failed retry must not move the conversation off the plain id.
  if (retry.ok) rescued.add(sessionId);
  return retry;
}

/** Intended for unit tests only. */
export function resetRuntimeSessions(): void {
  rescued.clear();
  isRescuedOnRow = () => false;
}
