/**
 * Session management API endpoints
 * API for managing sessions via DynamoDB and AgentCore Memory
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { isSessionId } from '@moca/core';
import { createAgentCoreMemoryServiceForRequest } from '../services/agentcore-memory.js';

import { getSessionsDynamoDBService } from '../services/sessions-dynamodb.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

const router = Router();

/**
 * Session list retrieval endpoint
 * GET /sessions
 * JWT authentication required - Use user ID as actorId
 * Returns all sessions from DynamoDB sorted by updatedAt (newest first)
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const actorId = req.identityId!;

    // Parse pagination query parameters
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const nextToken = req.query.nextToken as string | undefined;

    logger.info(
      {
        userId: actorId,
        username: auth.username,
        limit,
        hasNextToken: !!nextToken,
      },
      'Session list retrieval started (%s):',
      auth.requestId
    );

    const sessionsDynamoDBService = getSessionsDynamoDBService();

    // Check if DynamoDB Sessions Table is configured
    if (!sessionsDynamoDBService.isConfigured()) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Sessions Table is not configured',
        requestId: auth.requestId,
      });
    }

    // Use DynamoDB for session list with pagination
    const result = await sessionsDynamoDBService.listSessions(actorId, limit, nextToken);

    logger.info(
      `Session list retrieval completed (${auth.requestId}): ${result.sessions.length} items, hasMore: ${result.hasMore}`
    );

    res.status(200).json({
      sessions: result.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        sessionType: session.sessionType,
        agentId: session.agentId,
        storagePath: session.storagePath,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        actorId,
        count: result.sessions.length,
        nextToken: result.nextToken,
        hasMore: result.hasMore,
        source: 'dynamodb',
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Session list retrieval error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to retrieve session list',
      requestId: auth.requestId,
    });
  }
});

/**
 * Session conversation history retrieval endpoint
 * GET /sessions/:sessionId/events
 * JWT authentication required - Use user ID as actorId
 */
router.get(
  '/:sessionId/events',

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const actorId = req.identityId!;
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Session ID is not specified',
          requestId: auth.requestId,
        });
      }

      if (!isSessionId(sessionId)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Session ID format is invalid (must be 33 alphanumeric characters)',
          requestId: auth.requestId,
        });
      }

      // Verify session ownership via DynamoDB
      const sessionsDynamoDBService = getSessionsDynamoDBService();
      if (sessionsDynamoDBService.isConfigured()) {
        const session = await sessionsDynamoDBService.getSession(actorId, sessionId);
        if (!session) {
          logger.warn('Access denied to session (%s): %s', auth.requestId, sessionId);
          return res.status(403).json({
            error: 'Forbidden',
            message: 'You do not have permission to access this session',
            requestId: auth.requestId,
          });
        }
      }

      logger.info(
        {
          userId: actorId,
          username: auth.username,
          sessionId,
        },
        'Session conversation history retrieval started (%s):',
        auth.requestId
      );

      const memoryService = await createAgentCoreMemoryServiceForRequest(req);
      const events = await memoryService.getSessionEvents(actorId, sessionId);

      logger.info(
        `Session conversation history retrieval completed (${auth.requestId}): ${events.length} items`
      );

      res.status(200).json({
        events,
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          actorId,
          sessionId,
          count: events.length,
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error(
        { err: error },
        'Session conversation history retrieval error (%s):',
        auth.requestId
      );

      res.status(500).json({
        error: 'Internal Server Error',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to retrieve session conversation history',
        requestId: auth.requestId,
      });
    }
  }
);

/**
 * Session deletion endpoint
 * DELETE /sessions/:sessionId
 * JWT authentication required - Use user ID as actorId
 * Deletes from both DynamoDB and AgentCore Memory
 */
router.delete(
  '/:sessionId',

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const actorId = req.identityId!;
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Session ID is not specified',
          requestId: auth.requestId,
        });
      }

      if (!isSessionId(sessionId)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Session ID format is invalid (must be 33 alphanumeric characters)',
          requestId: auth.requestId,
        });
      }

      logger.info(
        {
          userId: actorId,
          username: auth.username,
          sessionId,
        },
        'Session deletion started (%s):',
        auth.requestId
      );

      // Verify session ownership before deletion
      const sessionsDynamoDBService = getSessionsDynamoDBService();
      if (sessionsDynamoDBService.isConfigured()) {
        const session = await sessionsDynamoDBService.getSession(actorId, sessionId);
        if (!session) {
          logger.warn('Access denied to delete session (%s): %s', auth.requestId, sessionId);
          return res.status(403).json({
            error: 'Forbidden',
            message: 'You do not have permission to delete this session',
            requestId: auth.requestId,
          });
        }
      }

      const errors: string[] = [];

      // Delete from DynamoDB
      if (sessionsDynamoDBService.isConfigured()) {
        try {
          await sessionsDynamoDBService.deleteSession(actorId, sessionId);
          logger.info('Deleted session from DynamoDB: %s', sessionId);
        } catch (dynamoError) {
          logger.error(
            { err: dynamoError },
            'Failed to delete session from DynamoDB: %s',
            sessionId
          );
          errors.push(
            `DynamoDB: ${dynamoError instanceof Error ? dynamoError.message : 'Unknown error'}`
          );
        }
      }

      // Delete from AgentCore Memory
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

      if (errors.length > 0) {
        logger.warn(
          { err: errors },
          'Session deletion completed with errors (%s):',
          auth.requestId
        );
      } else {
        logger.info('Session deletion completed successfully (%s)', auth.requestId);
      }

      res.status(200).json({
        success: true,
        message: 'Session deleted',
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          actorId,
          sessionId,
          warnings: errors.length > 0 ? errors : undefined,
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error({ err: error }, 'Session deletion error (%s):', auth.requestId);

      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to delete session',
        requestId: auth.requestId,
      });
    }
  }
);

export default router;
