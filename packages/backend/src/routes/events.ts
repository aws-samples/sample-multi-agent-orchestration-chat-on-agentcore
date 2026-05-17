/**
 * Events API endpoints
 * API for retrieving available event sources
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

const router = Router();

interface EventSource {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

/**
 * Get available event sources
 * GET /events
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);

    logger.info('Event sources retrieval started (%s)', auth.requestId);

    // `EVENT_SOURCES_CONFIG` defaults to `'[]'` in the config schema, so JSON.parse
    // always succeeds and produces an empty array when nothing is wired up.
    const eventSources: EventSource[] = JSON.parse(config.EVENT_SOURCES_CONFIG);

    logger.info(
      `Event sources retrieval completed (${auth.requestId}): ${eventSources.length} sources`
    );

    res.status(200).json({
      eventSources,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        count: eventSources.length,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Event sources retrieval error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to retrieve event sources',
      requestId: auth.requestId,
    });
  }
});

export default router;
