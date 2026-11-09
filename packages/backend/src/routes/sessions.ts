/**
 * Session management API endpoints
 * API for managing sessions via DynamoDB and AgentCore Memory.
 *
 * Handlers are wrapped in `asyncHandler` and throw `AppError` on failure; the
 * global `errorHandlerMiddleware` renders the canonical error envelope. The
 * caller identity (`actorId`) is `req.identityId`, populated by
 * `authMiddleware`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { type AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { createAgentCoreMemoryServiceForRequest } from '../services/agentcore-memory.js';
import { getSessionsRepository } from '../repositories/sessions/sessions-repository.factory.js';
import { config } from '../config/index.js';
import {
  AppError,
  ErrorCode,
  decodePageToken,
  ok,
  parseLimit,
  queryString,
  zSessionId,
} from '../libs/http/index.js';

const router = Router();

/** `:sessionId` path param schema shared by the item routes. */
const sessionIdParams = z.object({ sessionId: zSessionId });

/**
 * Session list retrieval endpoint
 * GET /sessions
 * Returns sessions from DynamoDB sorted by updatedAt (newest first).
 */
router.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const actorId = req.identityId!;

    const limit = parseLimit(req, 50);
    const nextToken = queryString(req.query.nextToken);
    // Decode/validate the opaque page token here (→ 400 on a malformed token),
    // consistent with the triggers routes, instead of an unguarded parse in the
    // service that would surface as a 500.
    const exclusiveStartKey = decodePageToken(nextToken);

    const sessionsRepository = getSessionsRepository();
    if (!sessionsRepository.isConfigured()) {
      throw new AppError(ErrorCode.CONFIGURATION_ERROR, 'Sessions Table is not configured');
    }

    const result = await sessionsRepository.listSessions(actorId, limit, exclusiveStartKey);

    res.status(200).json(
      ok(
        req,
        {
          sessions: result.sessions.map((session) => ({
            sessionId: session.sessionId,
            title: session.title,
            sessionType: session.sessionType,
            agentId: session.agentId,
            storagePath: session.storagePath,
            activeTurnStartedAt: session.activeTurnStartedAt,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          })),
          nextToken: result.nextToken,
          hasMore: result.hasMore,
        },
        { actorId, count: result.sessions.length, source: 'dynamodb' }
      )
    );
  })
);

/**
 * Session conversation history retrieval endpoint
 * GET /sessions/:sessionId/events
 */
router.get(
  '/:sessionId/events',
  validate({ params: sessionIdParams }),
  asyncHandler(async (req: AuthenticatedRequest<{ sessionId: string }>, res) => {
    const actorId = req.identityId!;
    const sessionId = req.params.sessionId;

    // Ownership check, scoped to the caller's actorId. A missing row is
    // "not found" (404) rather than "forbidden" — returning 404 leaks nothing
    // because a cross-user lookup is also falsy. Matches agents/triggers.
    const sessionsRepository = getSessionsRepository();
    if (sessionsRepository.isConfigured()) {
      const session = await sessionsRepository.getSession(actorId, sessionId);
      if (!session) {
        req.log.warn({ sessionId }, 'Session not found');
        throw new AppError(ErrorCode.NOT_FOUND, 'Session not found');
      }
    }

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const events = await memoryService.getSessionEvents(actorId, sessionId);

    res.status(200).json(ok(req, { events }, { actorId, sessionId, count: events.length }));
  })
);

/**
 * Session deletion endpoint
 * DELETE /sessions/:sessionId
 * Deletes from both AgentCore Memory and DynamoDB.
 *
 * Idempotent: deleting a missing/unowned session is a no-op success. If one of
 * the two backing stores fails, the endpoint reports a non-2xx error rather
 * than masking the partial failure behind `success: true`.
 */
router.delete(
  '/:sessionId',
  validate({ params: sessionIdParams }),
  asyncHandler(async (req: AuthenticatedRequest<{ sessionId: string }>, res) => {
    const actorId = req.identityId!;
    const sessionId = req.params.sessionId;

    const sessionsRepository = getSessionsRepository();
    let sessionExists = true;
    if (sessionsRepository.isConfigured()) {
      sessionExists = !!(await sessionsRepository.getSession(actorId, sessionId));
    }

    // Memory first, DynamoDB row last. The session list reads DynamoDB, so the
    // row is the user's only handle to retry: deleting it before Memory left
    // orphaned events with no way to retry once a Memory delete failed. The
    // Memory delete still runs when the row is absent (idempotent), which
    // cleans up after an older failure. The scoped client can only touch the
    // caller's own actorId, so an unowned session id is a no-op there.
    if (config.AGENTCORE_MEMORY_ID) {
      try {
        const memoryService = await createAgentCoreMemoryServiceForRequest(req);
        await memoryService.deleteSession(actorId, sessionId);
      } catch (memoryError) {
        req.log.error(
          { err: memoryError, sessionId },
          'Failed to delete session from AgentCore Memory'
        );
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          'Session was only partially deleted; please retry',
          {
            details: {
              failures: [
                `AgentCore Memory: ${memoryError instanceof Error ? memoryError.message : 'Unknown error'}`,
              ],
            },
          }
        );
      }
    }

    if (sessionsRepository.isConfigured() && sessionExists) {
      try {
        await sessionsRepository.deleteSession(actorId, sessionId);
      } catch (dynamoError) {
        req.log.error({ err: dynamoError, sessionId }, 'Failed to delete session from DynamoDB');
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          'Session was only partially deleted; please retry',
          {
            details: {
              failures: [
                `DynamoDB: ${dynamoError instanceof Error ? dynamoError.message : 'Unknown error'}`,
              ],
            },
          }
        );
      }
    }

    res
      .status(200)
      .json(ok(req, { success: true, message: 'Session deleted' }, { actorId, sessionId }));
  })
);

export default router;
