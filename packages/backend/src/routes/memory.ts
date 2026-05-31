/**
 * Memory API routes
 * Endpoints for managing long-term memory in AgentCore Memory
 *
 * All endpoints use `req.identityId` (populated by `authMiddleware`) as the
 * actor id so that Memory records are keyed consistently with how the agent
 * * writes them. `authMiddleware` rejects requests that did not forward the
 * Cognito ID Token header.
 *
 * Handlers are wrapped in `asyncHandler` and signal failures by throwing
 * `AppError`; the global `errorHandlerMiddleware` renders the canonical error
 * envelope. Request shapes are validated by `validate(...)` middleware, so
 * handlers receive already-typed `body`.
 *
 * The semantic memory strategyId is read from `config.AGENTCORE_SEMANTIC_STRATEGY_ID`
 * (resolved at CDK deploy time). The value is validated at startup by the
 * Zod schema in `config/index.ts`, so routes can use it directly without
 * runtime null checks.
 */

import { Router } from 'express';
import { z } from 'zod';

import { createAgentCoreMemoryServiceForRequest } from '../services/agentcore-memory.js';
import { type AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import { ok, parseLimit, queryString } from '../libs/http/index.js';

const router = Router();

/**
 * Get list of long-term memory records
 * GET /api/memory/records
 */
router.get(
  '/records',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const actorId = req.identityId!;

    const limit = parseLimit(req, 50);
    const nextToken = queryString(req.query.nextToken);

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const result = await memoryService.listMemoryRecords(
      actorId,
      config.AGENTCORE_SEMANTIC_STRATEGY_ID,
      nextToken,
      limit
    );

    logger.info(
      `[Memory API] Retrieved ${result.records.length} memory records for actorId: ${actorId}`
    );

    res.json(
      ok(
        req,
        { records: result.records, nextToken: result.nextToken },
        { actorId, count: result.records.length }
      )
    );
  })
);

/**
 * Treat an empty/whitespace-only string as "not provided" so it falls back to
 * the default. Without this, `z.coerce.number()` would coerce `''` to `0`
 * (Number('') === 0) — which passes `min(0)` and would silently run the search
 * with relevanceScore 0.0 (no relevance filtering) instead of the intended
 * default. A genuinely malformed value (e.g. 'abc') still fails validation.
 */
const emptyStringToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/** Request body for semantic memory search. */
const searchBody = z.object({
  query: z.string().min(1),
  topK: z.preprocess(emptyStringToUndefined, z.coerce.number().int().min(1).max(100)).default(10),
  relevanceScore: z
    .preprocess(emptyStringToUndefined, z.coerce.number().min(0).max(1))
    .default(0.2),
});

/**
 * Retrieve long-term memory records via semantic search
 * POST /api/memory/search
 */
router.post(
  '/search',
  validate({ body: searchBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const actorId = req.identityId!;

    const { query, topK, relevanceScore } = req.body;

    const memoryService = await createAgentCoreMemoryServiceForRequest(req);
    const records = await memoryService.retrieveMemoryRecords(
      actorId,
      config.AGENTCORE_SEMANTIC_STRATEGY_ID,
      query,
      topK,
      relevanceScore
    );

    logger.info(
      `[Memory API] Retrieved ${records.length} search results for query: "${query}" for actorId: ${actorId}`
    );

    res.json(ok(req, { records }, { actorId, query, count: records.length }));
  })
);

export default router;
