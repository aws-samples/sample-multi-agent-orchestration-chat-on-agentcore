/**
 * Events API endpoints
 * API for retrieving available event sources
 */

import { Router } from 'express';
import { AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import { ok } from '../libs/http/index.js';

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
router.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const auth = getCurrentAuth(req);

    logger.info('Event sources retrieval started (%s)', auth.requestId);

    // `EVENT_SOURCES_CONFIG` defaults to `'[]'` in the config schema, so JSON.parse
    // always succeeds and produces an empty array when nothing is wired up. Any
    // parse error propagates to the global error handler.
    const eventSources: EventSource[] = JSON.parse(config.EVENT_SOURCES_CONFIG);

    logger.info(
      `Event sources retrieval completed (${auth.requestId}): ${eventSources.length} sources`
    );

    res.status(200).json(ok(req, { eventSources }, { count: eventSources.length }));
  })
);

export default router;
