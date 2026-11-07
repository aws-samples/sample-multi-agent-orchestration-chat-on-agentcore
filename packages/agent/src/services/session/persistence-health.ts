/**
 * Surface "this turn is no longer being saved" once per turn.
 *
 * Persistence (AgentCore Memory, DynamoDB, S3 workspace sync) is deliberately
 * non-blocking, so when user-scoped credentials cannot be refreshed the turn
 * keeps going while every save fails. Without de-duplication that is one
 * warning per message and per file (thousands per turn) and nothing in the
 * UI. Credential-expiry failures are reported here instead: one error log and
 * one client warning event per turn. Other failures stay with the caller.
 */

import { logger } from '../../libs/logger/index.js';
import { getCurrentContext } from '../../libs/context/request-context.js';

export type PersistenceTarget = 'conversation' | 'workspace' | 'sessionMetadata';

const CREDENTIAL_EXPIRY_PATTERN =
  /ExpiredToken|security token included in the request is expired|UserCredentialsExpiredError/;

export function isCredentialExpiryError(error: unknown): boolean {
  if (typeof error === 'string') return CREDENTIAL_EXPIRY_PATTERN.test(error);
  if (error instanceof Error) {
    return CREDENTIAL_EXPIRY_PATTERN.test(`${error.name} ${error.message}`);
  }
  return false;
}

/**
 * @returns true when the failure was a credential expiry and has been
 *   handled here (the caller should not log it again); false otherwise.
 */
export function reportPersistenceFailure(target: PersistenceTarget, error: unknown): boolean {
  if (!isCredentialExpiryError(error)) return false;

  const ctx = getCurrentContext();
  if (ctx?.persistenceDegradedReported) return true;
  if (ctx) ctx.persistenceDegradedReported = true;

  logger.error(
    { requestId: ctx?.requestId, sessionId: ctx?.sessionId, target, err: error },
    'Persistence degraded: user-scoped credentials expired; conversation and workspace changes are no longer saved for this turn'
  );
  ctx?.emitClientEvent?.({
    type: 'serverWarningEvent',
    warning: {
      code: 'persistenceDegraded',
      target,
      message:
        'The session can no longer be saved because your sign-in expired. ' +
        'Keep this tab open while the agent runs, or reload and retry.',
    },
  });
  return true;
}
