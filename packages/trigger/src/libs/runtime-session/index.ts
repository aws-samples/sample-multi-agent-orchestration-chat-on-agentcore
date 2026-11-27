import { isSessionId, toRuntimeSessionId } from '@moca/core';

/**
 * Runtime session id for a machine-user call on a conversation. V2 pins a
 * runtime session to its first caller, so automation must never use the
 * conversation id humans use. A malformed id is passed through unchanged
 * (the Runtime treats it as sessionless, as before).
 */
export function machineRuntimeSessionId(sessionId: string): string {
  return isSessionId(sessionId) ? toRuntimeSessionId(sessionId, 'machine') : sessionId;
}
