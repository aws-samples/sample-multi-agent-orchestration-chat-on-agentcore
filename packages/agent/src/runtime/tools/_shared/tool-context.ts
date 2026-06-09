/**
 * Tool context helpers
 *
 * Each accessor surfaces a {@link ToolContextError} carrying a user-facing
 * message; `defineTool` catches it and returns that message to the model
 * instead of a generic stack trace.
 *
 * The presence/branded-type invariant lives once, in `libs/context`
 * (`requireUserId` / `requireIdentityId`). These wrappers delegate to it and
 * translate its internal-invariant Error into an actionable `ToolContextError`,
 * so tightening the check there automatically applies here.
 */

import type { IdentityId, UserId } from '@moca/core';
import {
  getCurrentContext,
  requireUserId as ctxRequireUserId,
  requireIdentityId as ctxRequireIdentityId,
} from '../../../libs/context/request-context.js';

/**
 * Error thrown when a tool requires a request-context field that has not been
 * populated. The `message` is intended to be surfaced directly to the model.
 */
export class ToolContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolContextError';
  }
}

/**
 * Resolve the authenticated Cognito User Pool `sub`, or throw a
 * `ToolContextError` with a login-prompt message when unauthenticated.
 */
export function requireUserId(): UserId {
  try {
    return ctxRequireUserId();
  } catch {
    throw new ToolContextError('User authentication information not found. Please log in again.');
  }
}

/**
 * Resolve the user-selected S3 storage path. Always populated once a
 * `RequestContext` exists (defaults to `'/'`), so a missing value indicates the
 * tool ran outside any request scope.
 */
export function requireStoragePath(): string {
  const ctx = getCurrentContext();
  if (!ctx) {
    throw new ToolContextError(
      'Request context is not available. The tool was invoked outside an active request.'
    );
  }
  return ctx.storagePath;
}

/**
 * Resolve the Cognito Identity Pool identityId (S3 prefix / Memory actor key),
 * or throw a `ToolContextError` when the per-user identity has not been
 * resolved for this request.
 */
export function requireIdentityId(): IdentityId {
  try {
    return ctxRequireIdentityId();
  } catch {
    throw new ToolContextError(
      'Could not determine the current user identity. ' +
        'Identity Pool identityId has not been resolved for this request.'
    );
  }
}
