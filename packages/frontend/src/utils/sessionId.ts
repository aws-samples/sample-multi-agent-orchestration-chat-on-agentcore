/**
 * Session ID utilities — re-exported from @moca/core
 *
 * This module is kept for backward compatibility.
 * New code should import directly from `@moca/core`.
 */
export {
  generateSessionId,
  isSessionId,
  parseSessionId,
  SESSION_ID_LENGTH,
  SESSION_ID_PATTERN,
} from '@moca/core';
export type { SessionId } from '@moca/core';
