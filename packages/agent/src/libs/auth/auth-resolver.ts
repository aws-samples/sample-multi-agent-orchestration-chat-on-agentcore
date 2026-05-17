/**
 * Authentication and User ID Resolution
 *
 * Pure functions that decide the effective actor for a request. Runs
 * AFTER `requestContextMiddleware` has cryptographically verified the
 * incoming JWTs — this module may therefore read `context.isMachineUser`,
 * `context.clientId`, `context.scopes`, and `context.userId` without
 * re-verifying, because those fields are populated exclusively from the
 * verified access-token payload.
 *
 * Responsibilities:
 *   - Regular user: use the `sub`-derived `UserId` in the context.
 *     Reject any attempt to set `targetUserId` (that field belongs to
 *     machine-user flows only).
 *   - Machine user: require `agent/invoke` scope and a well-formed
 *     `targetUserId` UUID in the request body.
 */

import { isUserId, type UserId } from '@moca/core';
import { logger } from '../logger/index.js';
import type { RequestContext } from '../context/request-context.js';

/**
 * Required OAuth scope for machine user invocation
 */
export const REQUIRED_MACHINE_USER_SCOPE = 'agent/invoke';

/**
 * Validate OAuth scopes for machine user
 * @param scopes - Array of OAuth scopes from the token
 * @returns Validation result with error if scopes are insufficient
 */
export function validateMachineUserScopes(scopes?: string[]): {
  valid: boolean;
  error?: { status: number; message: string };
} {
  if (!scopes || scopes.length === 0) {
    return {
      valid: false,
      error: {
        status: 403,
        message: `Insufficient scope: '${REQUIRED_MACHINE_USER_SCOPE}' scope is required for machine user invocation`,
      },
    };
  }

  if (!scopes.includes(REQUIRED_MACHINE_USER_SCOPE)) {
    return {
      valid: false,
      error: {
        status: 403,
        message: `Insufficient scope: '${REQUIRED_MACHINE_USER_SCOPE}' scope is required, but only [${scopes.join(', ')}] provided`,
      },
    };
  }

  return { valid: true };
}

/**
 * Validate targetUserId format
 * - Must be non-empty
 * - Must be a valid UUID format (Cognito sub)
 * @param targetUserId - Target user ID to validate (must be Cognito sub UUID)
 * @returns Validation result with error if invalid
 */
export function validateTargetUserId(targetUserId: string): {
  valid: boolean;
  error?: { status: number; message: string };
} {
  // Check for empty or whitespace-only
  if (!targetUserId.trim()) {
    return {
      valid: false,
      error: {
        status: 400,
        message: 'targetUserId cannot be empty or whitespace',
      },
    };
  }

  // UUID format validation (Cognito sub is always a UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(targetUserId)) {
    return {
      valid: false,
      error: {
        status: 400,
        message: 'targetUserId must be a valid UUID format (Cognito sub)',
      },
    };
  }

  return { valid: true };
}

/**
 * Resolved effective user ID plus any short-circuit 4xx error.
 * `userId` is `undefined` whenever `error` is set.
 */
export interface ResolveEffectiveUserIdResult {
  userId?: UserId;
  error?: { status: number; message: string };
}

/**
 * Resolve effective user ID based on authentication type.
 *
 * Preconditions (guaranteed by `requestContextMiddleware`):
 *   - If `context.accessTokenPayload` is set, the JWT has been fully
 *     verified (signature + claims). The `isMachineUser`, `clientId`,
 *     `scopes`, and `userId` fields are therefore trustworthy.
 *   - If `accessTokenPayload` is missing, no authentication has
 *     occurred — we fail closed with 401.
 */
export function resolveEffectiveUserId(
  context: RequestContext | undefined,
  targetUserId?: string
): ResolveEffectiveUserIdResult {
  if (!context?.accessTokenPayload) {
    // The only way to reach this branch is if a caller wired
    // `resolveEffectiveUserId` in somewhere that bypassed
    // `requestContextMiddleware`. Fail closed.
    return {
      error: {
        status: 401,
        message: 'Authenticated user ID could not be resolved from the JWT',
      },
    };
  }

  if (context.isMachineUser) {
    const scopeValidation = validateMachineUserScopes(context.scopes);
    if (!scopeValidation.valid && scopeValidation.error) {
      return { error: scopeValidation.error };
    }

    if (!targetUserId) {
      return {
        error: {
          status: 400,
          message: 'targetUserId is required for machine user (Client Credentials Flow)',
        },
      };
    }

    const targetUserIdValidation = validateTargetUserId(targetUserId);
    if (!targetUserIdValidation.valid && targetUserIdValidation.error) {
      return { error: targetUserIdValidation.error };
    }

    logger.info(
      {
        clientId: context.clientId,
        targetUserId,
        scopes: context.scopes,
        requestId: context.requestId,
      },
      'Machine user authentication verified'
    );
    // `validateTargetUserId` has enforced the UUID shape, so the brand
    // is sound.
    return { userId: targetUserId as UserId };
  }

  // Regular user: targetUserId is not allowed — it is a machine-user
  // impersonation parameter.
  if (targetUserId) {
    return {
      error: {
        status: 403,
        message: 'targetUserId is not allowed for regular users',
      },
    };
  }

  if (!context.userId) {
    return {
      error: {
        status: 401,
        message: 'Authenticated user ID could not be resolved from the JWT',
      },
    };
  }

  if (!isUserId(context.userId)) {
    // Defensive: `requestContextMiddleware` only assigns `userId` when
    // `isUserId` holds, so this should not fire in practice.
    return {
      error: {
        status: 401,
        message: 'JWT did not expose a user ID in the expected Cognito sub format',
      },
    };
  }

  return { userId: context.userId };
}
