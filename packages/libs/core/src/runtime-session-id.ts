/**
 * Runtime session id ≠ conversation (Session) id.
 *
 * On AgentCore Runtime V2 a runtime session is pinned to the identity that
 * first invoked it, and the pin outlives StopRuntimeSession and the idle
 * timeout. Humans (Cognito user tokens) and automation (machine-user
 * client-credentials tokens) therefore each get their own runtime session per
 * conversation:
 *
 * | kind      | runtime session id | used by                                      |
 * |-----------|--------------------|----------------------------------------------|
 * | `user`    | `<sessionId>u`     | humans                                       |
 * | `machine` | `<sessionId>m`     | triggers, workflow steps, workflow callbacks |
 *
 * Nobody sends the plain id any more: before the split both sides used it, so
 * on an existing conversation it may be pinned to either. A plain id is still
 * parsed (`kind: 'plain'`) for clients deployed before the split.
 *
 * Session ids are fixed 33-char alphanumerics, so the 34-char forms are
 * unambiguous and stay within every downstream limit.
 */

import { isSessionId, SESSION_ID_LENGTH, type SessionId } from './session-id.js';

export type RuntimeSessionKind = 'user' | 'machine';

const SUFFIX: Record<RuntimeSessionKind, string> = { user: 'u', machine: 'm' };

export function toRuntimeSessionId(sessionId: SessionId, kind: RuntimeSessionKind): string {
  return `${sessionId}${SUFFIX[kind]}`;
}

export interface ParsedRuntimeSessionId {
  sessionId: SessionId;
  kind: RuntimeSessionKind | 'plain';
}

/** @returns undefined for anything that is not a Moca runtime session id. */
export function parseRuntimeSessionId(value: string): ParsedRuntimeSessionId | undefined {
  if (isSessionId(value)) return { sessionId: value, kind: 'plain' };
  if (value.length !== SESSION_ID_LENGTH + 1) return undefined;
  const base = value.slice(0, SESSION_ID_LENGTH);
  if (!isSessionId(base)) return undefined;
  const suffix = value.slice(SESSION_ID_LENGTH);
  if (suffix === SUFFIX.user) return { sessionId: base, kind: 'user' };
  if (suffix === SUFFIX.machine) return { sessionId: base, kind: 'machine' };
  return undefined;
}
