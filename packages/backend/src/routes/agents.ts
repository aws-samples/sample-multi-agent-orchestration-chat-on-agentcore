/**
 * Agent management API endpoints
 * API for managing user Agents in DynamoDB
 *
 * Handlers are wrapped in `asyncHandler` and signal failures by throwing
 * `AppError`; the global `errorHandlerMiddleware` renders the canonical error
 * envelope. Request shapes are validated by `validate(...)` middleware, so
 * handlers receive already-typed `params`/`body`.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  getCurrentAuth,
  requireUserId,
  resolveTargetUser,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { parseUserId, parseAgentId } from '@moca/core';
import { createAgentsService, UpdateAgentInput } from '../services/agents-service.js';
import { AgentNotFoundError } from '../types/index.js';
import { DEFAULT_AGENTS } from '../config/data/default-agents.js';
import {
  AppError,
  ErrorCode,
  ok,
  parseLimit,
  queryString,
  zAgentId,
  zUserId,
} from '../libs/http/index.js';

const router = Router();

/** `:agentId` path param schema shared by the item routes. */
const agentIdParams = z.object({ agentId: zAgentId });

/** `:userId/:agentId` path param schema shared by the shared-agents item routes. */
const sharedAgentParams = z.object({ userId: zUserId, agentId: zAgentId });

/** Request body for creating an agent. */
const createAgentBody = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  enabledTools: z.array(z.string()),
  icon: z.string().optional(),
  scenarios: z.array(z.any()).optional(),
  mcpConfig: z.any().optional(),
  defaultStoragePath: z.string().optional(),
});

/** Request body for updating an agent (partial). */
const updateAgentBody = createAgentBody.partial();

/**
 * Agent list retrieval endpoint
 * GET /agents
 * JWT authentication required
 */
router.get(
  '/',
  resolveTargetUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.targetUserId!;

    const agentsService = createAgentsService();
    const agents = await agentsService.listAgents(userId);

    res.status(200).json(ok(req, { agents }, { userId, count: agents.length }));
  })
);

/**
 * Specific Agent retrieval endpoint
 * GET /agents/:agentId
 * JWT authentication required
 */
router.get(
  '/:agentId',
  resolveTargetUser,
  validate({ params: agentIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.targetUserId!;
    const agentId = parseAgentId(req.params.agentId);

    const agentsService = createAgentsService();
    const agent = await agentsService.getAgent(userId, agentId);

    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
    }

    res.status(200).json(ok(req, { agent }, { userId }));
  })
);

/**
 * Agent creation endpoint
 * POST /agents
 * JWT authentication required
 */
router.post(
  '/',
  resolveTargetUser,
  validate({ body: createAgentBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const auth = getCurrentAuth(req);
    const userId = req.targetUserId!;
    const input = req.body;

    const agentsService = createAgentsService();
    // `scenarios` is optional on the wire but `createAgent` dereferences it
    // unconditionally; default to an empty array so an omitted field is a
    // valid no-scenario agent rather than a 500.
    const agent = await agentsService.createAgent(
      userId,
      { ...input, scenarios: input.scenarios ?? [] },
      auth.username
    );

    res.status(201).json(ok(req, { agent }, { userId }));
  })
);

/**
 * Agent update endpoint
 * PUT /agents/:agentId
 * JWT authentication required
 */
router.put(
  '/:agentId',
  resolveTargetUser,
  validate({ params: agentIdParams, body: updateAgentBody }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.targetUserId!;
    const agentId = parseAgentId(req.params.agentId);
    const input = req.body;

    const agentsService = createAgentsService();
    const updateInput: UpdateAgentInput = {
      agentId,
      ...input,
    };

    let agent;
    try {
      agent = await agentsService.updateAgent(userId, updateInput);
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
      }
      throw e;
    }

    res.status(200).json(ok(req, { agent }, { userId }));
  })
);

/**
 * Agent deletion endpoint
 * DELETE /agents/:agentId
 * JWT authentication required
 */
router.delete(
  '/:agentId',
  validate({ params: agentIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const agentId = parseAgentId(req.params.agentId);

    const agentsService = createAgentsService();
    await agentsService.deleteAgent(userId, agentId);

    res.status(200).json(ok(req, { success: true }, { userId }));
  })
);

/**
 * Agent share status toggle endpoint
 * PUT /agents/:agentId/share
 * JWT authentication required
 */
router.put(
  '/:agentId/share',
  validate({ params: agentIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = requireUserId(req);
    const agentId = parseAgentId(req.params.agentId);

    const agentsService = createAgentsService();
    let agent;
    try {
      agent = await agentsService.toggleShare(userId, agentId);
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Agent not found');
      }
      throw e;
    }

    res.status(200).json(ok(req, { agent }, { userId }));
  })
);

/**
 * Default Agent initialization endpoint
 * POST /agents/initialize
 * JWT authentication required
 * Create default Agents on first login
 */
router.post(
  '/initialize',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const auth = getCurrentAuth(req);
    const userId = requireUserId(req);

    const agentsService = createAgentsService();

    // Check if existing Agents exist
    const existingAgents = await agentsService.listAgents(userId);

    if (existingAgents.length > 0) {
      req.log.info({ count: existingAgents.length }, 'Skipping initialization because existing Agents exist');
      res.status(200).json(
        ok(
          req,
          {
            agents: existingAgents,
            skipped: true,
            message: 'Initialization skipped because existing Agents exist',
          },
          { userId, count: existingAgents.length }
        )
      );
      return;
    }

    // Create default Agents
    const agents = await agentsService.initializeDefaultAgents(
      userId,
      DEFAULT_AGENTS,
      auth.username
    );

    res
      .status(201)
      .json(ok(req, { agents, skipped: false }, { userId, count: agents.length }));
  })
);

/**
 * Shared Agent list retrieval endpoint (with pagination support)
 * GET /shared-agents/list
 * Query parameters:
 *   - q: Search query (optional)
 *   - limit: Number of items to retrieve (default: 20)
 *   - cursor: Pagination cursor (optional)
 * JWT authentication required
 *
 * System default agents are stored in DynamoDB with isShared='true'
 * and are returned alongside user-shared agents from the GSI query.
 */
router.get(
  '/shared-agents/list',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    // Clamp the page size with the shared helper (NaN/negative → default 20,
    // capped at MAX_PAGE_SIZE) instead of an unbounded parseInt, consistent
    // with the other list endpoints.
    const limit = parseLimit(req, 20);
    const searchQuery = queryString(req.query.q);
    const cursor = queryString(req.query.cursor);

    const agentsService = createAgentsService();
    const result = await agentsService.listSharedAgents(limit, searchQuery, cursor);

    res.status(200).json(
      ok(
        req,
        { agents: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore },
        { count: result.items.length }
      )
    );
  })
);

/**
 * Shared Agent detail retrieval endpoint
 * GET /shared-agents/:userId/:agentId
 * JWT authentication required
 * All agents (including system defaults) are stored in DynamoDB.
 */
router.get(
  '/shared-agents/:userId/:agentId',
  validate({ params: sharedAgentParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = parseUserId(req.params.userId);
    const agentId = parseAgentId(req.params.agentId);

    const agentsService = createAgentsService();
    const agent = await agentsService.getSharedAgent(userId, agentId);

    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Shared Agent not found');
    }

    res.status(200).json(ok(req, { agent }));
  })
);

/**
 * Shared Agent clone endpoint
 * POST /shared-agents/:userId/:agentId/clone
 * JWT authentication required
 * All agents (including system defaults) are cloned via the same path.
 */
router.post(
  '/shared-agents/:userId/:agentId/clone',
  validate({ params: sharedAgentParams }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const auth = getCurrentAuth(req);
    const targetUserId = requireUserId(req);
    const sourceUserId = parseUserId(req.params.userId);
    const sourceAgentId = parseAgentId(req.params.agentId);

    const agentsService = createAgentsService();
    let clonedAgent;
    try {
      clonedAgent = await agentsService.cloneAgent(
        targetUserId,
        sourceUserId,
        sourceAgentId,
        auth.username
      );
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Shared Agent not found');
      }
      throw e;
    }

    res.status(201).json(ok(req, { agent: clonedAgent }, { userId: targetUserId }));
  })
);

export default router;
