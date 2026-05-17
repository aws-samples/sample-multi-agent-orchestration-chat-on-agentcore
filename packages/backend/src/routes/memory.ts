/**
 * Memory API routes
 * Endpoints for managing long-term memory in AgentCore Memory
 *
 * All endpoints use `req.identityId` (populated by `authMiddleware`) as the
 * actor id so that Memory records are keyed consistently with how the agent
 * * writes them. `authMiddleware` rejects requests that did not forward the
 * Cognito ID Token header.
 *
 * The semantic memory strategyId is read from `config.AGENTCORE_SEMANTIC_STRATEGY_ID`
 * (resolved at CDK deploy time). The value is validated at startup by the
 * Zod schema in `config/index.ts`, so routes can use it directly without
 * runtime null checks.
 */

import { Router, Response } from 'express';

import { createAgentCoreMemoryServiceForRequest } from '../services/agentcore-memory.js';
import { type AuthenticatedRequest } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

const router = Router();

/**
 * Get list of long-term memory records
 * GET /api/memory/records
 */
router.get('/records', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actorId = req.identityId!;

    const { nextToken } = req.query;

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const result = await memoryService.listMemoryRecords(
      actorId,
      config.AGENTCORE_SEMANTIC_STRATEGY_ID,
      typeof nextToken === 'string' ? nextToken : undefined
    );

    logger.info(
      `[Memory API] Retrieved ${result.records.length} memory records for actorId: ${actorId}`
    );

    res.json({
      records: result.records,
      nextToken: result.nextToken,
    });
  } catch (error) {
    logger.error({ err: error }, '[Memory API] Error retrieving memory records:');
    res.status(500).json({
      error: 'Failed to retrieve memory records',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Retrieve long-term memory records via semantic search
 * POST /api/memory/search
 */
router.post('/search', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actorId = req.identityId!;

    const { query, topK = 10, relevanceScore = 0.2 } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query is required' });
    }

    const topKNum = typeof topK === 'number' ? topK : parseInt(topK, 10);
    const relevanceScoreNum =
      typeof relevanceScore === 'number' ? relevanceScore : parseFloat(relevanceScore);

    if (isNaN(topKNum) || topKNum < 1 || topKNum > 100) {
      return res.status(400).json({ error: 'topK must be a number between 1 and 100' });
    }

    if (isNaN(relevanceScoreNum) || relevanceScoreNum < 0 || relevanceScoreNum > 1) {
      return res.status(400).json({ error: 'relevanceScore must be a number between 0 and 1' });
    }

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const records = await memoryService.retrieveMemoryRecords(
      actorId,
      config.AGENTCORE_SEMANTIC_STRATEGY_ID,
      query,
      topKNum,
      relevanceScoreNum
    );

    logger.info(
      `[Memory API] Retrieved ${records.length} search results for query: "${query}" for actorId: ${actorId}`
    );

    res.json({ records });
  } catch (error) {
    logger.error({ err: error }, '[Memory API] Error searching memory records:');
    res.status(500).json({
      error: 'Failed to search memory records',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
