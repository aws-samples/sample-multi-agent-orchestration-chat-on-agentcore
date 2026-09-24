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
import {
  SESSION_EVENTS_DEFAULT_LIMIT,
  SESSION_EVENTS_MAX_LIMIT,
} from '../services/agentcore-memory.js';
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
 * Session conversation history retrieval endpoint — paginated.
 *
 * GET /sessions/:sessionId/events?limit=50&cursor=<opaque>
 *
 * The previous implementation returned all events as a single JSON response.
 * With long sessions (e.g. 622 messages ≈ 13 MB) that exceeded the ~6 MiB
 * Lambda response limit and surfaced as an internal 413 → external 500.
 *
 * Pagination contract:
 *   - `limit`  — items per page, 1–SESSION_EVENTS_MAX_LIMIT (default
 *                SESSION_EVENTS_DEFAULT_LIMIT). Clamped; non-numeric/negative
 *                falls back to default.
 *   - `cursor` — opaque base64url token from a previous response. The token
 *                carries both the upstream continuation token AND the
 *                sessionId so cross-session cursor replay is rejected with 400.
 *   - Response payload:
 *       { events, nextCursor?, hasMore, metadata }
 *     `events` are ordered oldest-first within the page, consistent with the
 *     upstream ListEvents sort order. `nextCursor` is absent (or undefined)
 *     when there are no further pages.
 *
 * Large single event:
 *   If a single event alone exceeds the byte budget the endpoint returns 413
 *   with code PAYLOAD_TOO_LARGE so the client can surface an actionable error
 *   rather than receiving an empty page with no indication of the cause.
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

    const limit = parseLimit(req, SESSION_EVENTS_DEFAULT_LIMIT, SESSION_EVENTS_MAX_LIMIT);
    const cursor = queryString(req.query.cursor);

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const page = await memoryService.getSessionEventsPage(actorId, sessionId, limit, cursor);

    res.status(200).json(
      ok(
        req,
        {
          events: page.messages,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
        { actorId, sessionId, count: page.messages.length }
      )
    );
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
  asyncHandler(async (req: AuthenticatedRequest<{ sessionId: string }>, res) => {
    const actorId = req.identityId!;
    const sessionId = req.params.sessionId;

    // Ownership check. A missing DynamoDB row means the session is either
    // already deleted or not owned by this caller, so we skip the DynamoDB
    // delete — but we still run the Memory delete below. This is what makes a
    // retry safe: if a previous attempt deleted the DynamoDB row but failed on
    // Memory, the row is now absent yet the Memory events may still be orphaned,
    // so we must NOT short-circuit to success here without re-attempting Memory.
    const sessionsRepository = getSessionsRepository();
    let sessionExists = true;
    if (sessionsRepository.isConfigured()) {
      sessionExists = !!(await sessionsRepository.getSession(actorId, sessionId));
    }

    const errors: string[] = [];

    if (sessionsRepository.isConfigured() && sessionExists) {
      try {
        await sessionsRepository.deleteSession(actorId, sessionId);
      } catch (dynamoError) {
        req.log.error({ err: dynamoError, sessionId }, 'Failed to delete session from DynamoDB');
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
      } catch (memoryError) {
        req.log.error(
          { err: memoryError, sessionId },
          'Failed to delete session from AgentCore Memory'
        );
        errors.push(
          `AgentCore Memory: ${memoryError instanceof Error ? memoryError.message : 'Unknown error'}`
        );
      }
    }

    // A partial failure must NOT be reported as success — the row may still
    // exist while the client believes the session is gone.
    if (errors.length > 0) {
      req.log.warn({ failures: errors }, 'Session deletion failed partially');
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        'Session was only partially deleted; please retry',
        { details: { failures: errors } }
      );
    }

    res
      .status(200)
      .json(ok(req, { success: true, message: 'Session deleted' }, { actorId, sessionId }));
  })
);

export default router;
