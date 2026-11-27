/**
 * Which AgentCore Runtime session a human reaches a conversation through.
 *
 * On Runtime V2 a runtime session is pinned to its first caller for good (the
 * pin survives StopRuntimeSession and the idle timeout). Humans always use the
 * `u` runtime session and automation the `m` one, so neither is ever locked
 * out, including on conversations from before the split, whose plain id may be
 * pinned to either side (see `toRuntimeSessionId`).
 */

import { isSessionId, toRuntimeSessionId } from '@moca/core';
import { agentClient } from './client/agent-client';

const RUNTIME_SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

export function runtimeSessionIdFor(sessionId: string): string {
  return isSessionId(sessionId) ? toRuntimeSessionId(sessionId, 'user') : sessionId;
}

/** POST to the Runtime on the caller's runtime session for `sessionId`. */
export function invokeOnRuntimeSession(sessionId: string, init: RequestInit): Promise<Response> {
  return agentClient.invoke({
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      [RUNTIME_SESSION_HEADER]: runtimeSessionIdFor(sessionId),
    },
  });
}
