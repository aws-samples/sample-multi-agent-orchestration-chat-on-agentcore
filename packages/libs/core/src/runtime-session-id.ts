/**
 * Runtime session ID ≠ conversation (Session) ID.
 *
 * On AgentCore Runtime V2 a runtime session is pinned to the identity that
 * first invoked it, and the pin outlives StopRuntimeSession. Humans (Cognito
 * user tokens) and automation (machine-user client-credentials tokens) must
 * therefore never share a runtime session, even for the same conversation.
 *
 * | kind      | runtime session id | used by                                           |
 * |-----------|--------------------|---------------------------------------------------|
 * | `user`    | `<sessionId>`      | humans (default; keeps today's microVM reuse)      |
 * | `machine` | `<sessionId>m`     | triggers, workflow steps, workflow callbacks       |
 * | `rescued` | `<sessionId>u`     | humans on a conversation whose plain id was pinned |
 * |           |                    | to the machine user before runtime ids were split  |
 *
 * Session IDs are fixed 33-char alphanumerics, so the 34-char forms are
 * unambiguous and stay within every downstream limit.
 */

import { isSessionId, SESSION_ID_LENGTH, type SessionId } from './session-id.js';

export type RuntimeSessionKind = 'user' | 'machine' | 'rescued';

const SUFFIX: Record<RuntimeSessionKind, string> = { user: '', machine: 'm', rescued: 'u' };

export function toRuntimeSessionId(sessionId: SessionId, kind: RuntimeSessionKind): string {
  return `${sessionId}${SUFFIX[kind]}`;
}

export interface ParsedRuntimeSessionId {
  sessionId: SessionId;
  kind: RuntimeSessionKind;
}

/** @returns undefined for anything that is not a Moca runtime session id. */
export function parseRuntimeSessionId(value: string): ParsedRuntimeSessionId | undefined {
  if (isSessionId(value)) return { sessionId: value, kind: 'user' };
  if (value.length !== SESSION_ID_LENGTH + 1) return undefined;
  const base = value.slice(0, SESSION_ID_LENGTH);
  if (!isSessionId(base)) return undefined;
  const suffix = value.slice(SESSION_ID_LENGTH);
  if (suffix === SUFFIX.machine) return { sessionId: base, kind: 'machine' };
  if (suffix === SUFFIX.rescued) return { sessionId: base, kind: 'rescued' };
  return undefined;
}
