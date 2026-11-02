/**
 * OAuth API endpoints
 *
 * Completes the AgentCore Identity "URL session binding" for Gateway targets
 * that use per-user OAuth (Authorization Code / 3LO). After the user consents,
 * the browser lands on the frontend `/oauth/callback?session_id=...`, which
 * forwards the session URI here. AgentCore Identity then verifies that the
 * caller's JWT belongs to the same user who started the flow before it stores
 * the token. See docs/adr/gateway-3lo-github.md.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { type AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { extractJWTFromHeader } from '../libs/auth/jwks.js';
import { config } from '../config/index.js';
import { AppError, ErrorCode, ok } from '../libs/http/index.js';

/** Session URI format issued by AgentCore Identity (RFC 9126 request_uri). */
export const completeOAuthBody = z.object({
  sessionUri: z
    .string()
    .max(512)
    .regex(/^urn:ietf:params:oauth:request_uri:[A-Za-z0-9_\-=]+$/, 'Invalid session URI'),
});

/**
 * AgentCore Identity answers an expired (10 min), unknown, or other-user
 * session with AccessDeniedException "Invalid or expired session" (verified
 * live), not ValidationException. IAM denials ("... is not authorized to
 * perform ...") stay upstream errors. The detail is never echoed so the
 * endpoint cannot be used as an oracle.
 */
function isRejectedSession(error: unknown): boolean {
  const { name, message = '' } = error as { name?: string; message?: string };
  if (name === 'ValidationException') return true;
  return name === 'AccessDeniedException' && !/not authorized to perform/i.test(message);
}

let agentCoreClient: BedrockAgentCoreClient | undefined;
function getAgentCoreClient(): BedrockAgentCoreClient {
  agentCoreClient ??= new BedrockAgentCoreClient({ region: config.AWS_REGION });
  return agentCoreClient;
}

export function createOAuthRouter(getClient: () => BedrockAgentCoreClient = getAgentCoreClient) {
  const router = Router();

  /**
   * Complete a 3LO authorization started by a Gateway tool call.
   * POST /oauth/complete
   */
  router.post(
    '/complete',
    validate({ body: completeOAuthBody }),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      // A machine user is shared by every user's triggers; binding a token to it
      // would let all of them act as the consenting user.
      if (getCurrentAuth(req).isMachineUser) {
        throw new AppError(ErrorCode.FORBIDDEN, 'Machine users cannot complete user authorization');
      }
      // The same access token the agent forwards to the Gateway — the Identity
      // service derives the user from it, so it must not come from the body.
      const userToken = extractJWTFromHeader(req.get('Authorization') ?? '');
      if (!userToken) {
        throw new AppError(ErrorCode.UNAUTHENTICATED, 'Bearer token is required');
      }

      const { sessionUri } = req.body as z.infer<typeof completeOAuthBody>;
      try {
        await getClient().send(
          new CompleteResourceTokenAuthCommand({ sessionUri, userIdentifier: { userToken } })
        );
      } catch (error) {
        if (isRejectedSession(error)) {
          req.log.warn(
            { errName: (error as { name?: string }).name },
            'OAuth session binding rejected'
          );
          throw new AppError(
            ErrorCode.INVALID_ARGUMENT,
            'The authorization session is invalid or has expired. Please try again.'
          );
        }
        throw new AppError(ErrorCode.UPSTREAM_ERROR, 'Failed to complete authorization', {
          cause: error,
        });
      }

      req.log.info('OAuth session binding completed');
      res.json(ok(req, { completed: true }));
    })
  );

  return router;
}

export default createOAuthRouter();
