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
import { type AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { createAgentCoreMemoryServiceForRequest } from '../services/agentcore-memory.js';
import { getSessionsDynamoDBService } from '../services/sessions-dynamodb.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
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
    const auth = getCurrentAuth(req);
    const actorId = req.identityId!;

    const limit = parseLimit(req, 50);
    const nextToken = queryString(req.query.nextToken);
    // Decode/validate the opaque page token here (→ 400 on a malformed token),
    // consistent with the triggers routes, instead of an unguarded parse in the
    // service that would surface as a 500.
    const exclusiveStartKey = decodePageToken(nextToken);

    logger.info(
      { userId: actorId, username: auth.username, limit, hasNextToken: !!nextToken },
      'Session list retrieval started (%s):',
      auth.requestId
    );

    const sessionsDynamoDBService = getSessionsDynamoDBService();
    if (!sessionsDynamoDBService.isConfigured()) {
      throw new AppError(ErrorCode.CONFIGURATION_ERROR, 'Sessions Table is not configured');
    }

    const result = await sessionsDynamoDBService.listSessions(actorId, limit, exclusiveStartKey);

    logger.info(
      `Session list retrieval completed (${auth.requestId}): ${result.sessions.length} items, hasMore: ${result.hasMore}`
    );

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
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const auth = getCurrentAuth(req);
    const actorId = req.identityId!;
    const { sessionId } = req.params;

    // Ownership check, scoped to the caller's actorId. A missing row is
    // "not found" (404) rather than "forbidden" — returning 404 leaks nothing
    // because a cross-user lookup is also falsy. Matches agents/triggers.
    const sessionsDynamoDBService = getSessionsDynamoDBService();
    if (sessionsDynamoDBService.isConfigured()) {
      const session = await sessionsDynamoDBService.getSession(actorId, sessionId);
      if (!session) {
        logger.warn('Session not found (%s): %s', auth.requestId, sessionId);
        throw new AppError(ErrorCode.NOT_FOUND, 'Session not found');
      }
    }

    logger.info(
      { userId: actorId, username: auth.username, sessionId },
      'Session conversation history retrieval started (%s):',
      auth.requestId
    );

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const events = await memoryService.getSessionEvents(actorId, sessionId);

    logger.info(
      `Session conversation history retrieval completed (${auth.requestId}): ${events.length} items`
    );

    res.status(200).json(ok(req, { events }, { actorId, sessionId, count: events.length }));
  })
);

/**
 * Session deletion endpoint
 * DELETE /sessions/:sessionId
 * Deletes from both DynamoDB and AgentCore Memory.
 *
 * Idempotent: deleting a missing/unowned session is a no-op success. If one of
 * the two backing stores fails, the endpoint reports a non-2xx error rather
 * than masking the partial failure behind `success: true`.
 */
router.delete(
  '/:sessionId',
  validate({ params: sessionIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const auth = getCurrentAuth(req);
    const actorId = req.identityId!;
    const { sessionId } = req.params;

    logger.info(
      { userId: actorId, username: auth.username, sessionId },
      'Session deletion started (%s):',
      auth.requestId
    );

    // Ownership check. A missing DynamoDB row means the session is either
    // already deleted or not owned by this caller, so we skip the DynamoDB
    // delete — but we still run the Memory delete below. This is what makes a
    // retry safe: if a previous attempt deleted the DynamoDB row but failed on
    // Memory, the row is now absent yet the Memory events may still be orphaned,
    // so we must NOT short-circuit to success here without re-attempting Memory.
    const sessionsDynamoDBService = getSessionsDynamoDBService();
    let sessionExists = true;
    if (sessionsDynamoDBService.isConfigured()) {
      sessionExists = !!(await sessionsDynamoDBService.getSession(actorId, sessionId));
    }

    const errors: string[] = [];

    if (sessionsDynamoDBService.isConfigured() && sessionExists) {
      try {
        await sessionsDynamoDBService.deleteSession(actorId, sessionId);
        logger.info('Deleted session from DynamoDB: %s', sessionId);
      } catch (dynamoError) {
        logger.error({ err: dynamoError }, 'Failed to delete session from DynamoDB: %s', sessionId);
        errors.push(
          `DynamoDB: ${dynamoError instanceof Error ? dynamoError.message : 'Unknown error'}`
        );
      }
    }

    // Always attempt the Memory delete (it is idempotent — a session with no
    // events is a no-op), so a retry after a prior Memory failure cleans up the
    // orphaned events even though the DynamoDB row is already gone.
    if (config.AGENTCORE_MEMORY_ID) {
      try {
        const memoryService = await createAgentCoreMemoryServiceForRequest(req);
        await memoryService.deleteSession(actorId, sessionId);
        logger.info('Deleted session from AgentCore Memory: %s', sessionId);
      } catch (memoryError) {
        logger.error(
          { err: memoryError },
          'Failed to delete session from AgentCore Memory: %s',
          sessionId
        );
        errors.push(
          `AgentCore Memory: ${memoryError instanceof Error ? memoryError.message : 'Unknown error'}`
        );
      }
    }

    // A partial failure must NOT be reported as success — the row may still
    // exist while the client believes the session is gone.
    if (errors.length > 0) {
      logger.warn({ err: errors }, 'Session deletion failed partially (%s):', auth.requestId);
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Session was only partially deleted; please retry',
        { details: { failures: errors } }
      );
    }

    logger.info('Session deletion completed successfully (%s)', auth.requestId);

    res
      .status(200)
      .json(ok(req, { success: true, message: 'Session deleted' }, { actorId, sessionId }));
  })
);

export default router;
