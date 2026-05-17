/**
 * Agent management API endpoints
 * API for managing user Agents in DynamoDB
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest, getCurrentAuth, AuthInfo } from '../middleware/auth.js';
import { parseUserId, parseAgentId, isAgentId, isUserId } from '@moca/core';
import type { UserId } from '@moca/core';
import {
  createAgentsService,
  CreateAgentInput,
  UpdateAgentInput,
} from '../services/agents-service.js';
import { DEFAULT_AGENTS } from '../config/data/default-agents.js';
import { logger } from '../libs/logger/index.js';

const router = Router();

/**
 * UUID format regex for validating X-Target-User-Id
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve effective userId for agent API requests.
 *
 * For regular users: uses userId from JWT token.
 * For machine users (Client Credentials Flow): uses X-Target-User-Id header.
 * This enables EventBridge Scheduler triggered agents to access agent definitions
 * on behalf of the target user.
 */
function resolveUserId(
  auth: AuthInfo,
  req: AuthenticatedRequest
): { userId: UserId } | { error: string } {
  if (auth.isMachineUser) {
    const targetUserId = req.headers['x-target-user-id'] as string | undefined;
    if (!targetUserId) {
      return { error: 'X-Target-User-Id header is required for machine user requests' };
    }
    if (!UUID_REGEX.test(targetUserId)) {
      return { error: 'X-Target-User-Id must be a valid UUID format' };
    }
    return { userId: parseUserId(targetUserId) };
  }

  if (!auth.userId) {
    return { error: 'Failed to retrieve user ID' };
  }
  return { userId: parseUserId(auth.userId) };
}

/**
 * Agent list retrieval endpoint
 * GET /agents
 * JWT authentication required
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const result = resolveUserId(auth, req);

    if ('error' in result) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: result.error,
        requestId: auth.requestId,
      });
    }

    const { userId } = result;

    logger.info(
      {
        userId,
        username: auth.username,
      },
      'Agent list retrieval started (%s):',
      auth.requestId
    );

    const agentsService = createAgentsService();
    const agents = await agentsService.listAgents(userId);

    logger.info('Agent list retrieval completed (%s): %d items', auth.requestId, agents.length);

    res.status(200).json({
      agents: agents,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
        count: agents.length,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Agent list retrieval error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to retrieve Agent list',
      requestId: auth.requestId,
    });
  }
});

/**
 * Specific Agent retrieval endpoint
 * GET /agents/:agentId
 * JWT authentication required
 */
router.get('/:agentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const result = resolveUserId(auth, req);
    const agentId = isAgentId(req.params.agentId) ? parseAgentId(req.params.agentId) : undefined;

    if ('error' in result) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: result.error,
        requestId: auth.requestId,
      });
    }

    const { userId } = result;

    if (!agentId) {
      return res.status(400).json({
        error: 'Invalid request',
        message: `Agent ID format is invalid (must be a UUID): "${req.params.agentId}"`,
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        username: auth.username,
        agentId,
      },
      'Agent retrieval started (%s):',
      auth.requestId
    );

    const agentsService = createAgentsService();
    const agent = await agentsService.getAgent(userId, agentId);

    if (!agent) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Agent not found',
        requestId: auth.requestId,
      });
    }

    logger.info('Agent retrieval completed (%s): %s', auth.requestId, agent.name);

    res.status(200).json({
      agent: agent,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Agent retrieval error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to retrieve Agent',
      requestId: auth.requestId,
    });
  }
});

/**
 * Agent creation endpoint
 * POST /agents
 * JWT authentication required
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const result = resolveUserId(auth, req);
    const input: CreateAgentInput = req.body;

    if ('error' in result) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: result.error,
        requestId: auth.requestId,
      });
    }

    const { userId } = result;

    // Validation
    if (!input.name || !input.description || !input.systemPrompt || !input.enabledTools) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Required fields are missing',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        username: auth.username,
        agentName: input.name,
      },
      'Agent creation started (%s):',
      auth.requestId
    );

    const agentsService = createAgentsService();
    const agent = await agentsService.createAgent(userId, input, auth.username);

    logger.info('Agent creation completed (%s): %s', auth.requestId, agent.agentId);

    res.status(201).json({
      agent: agent,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Agent creation error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to create Agent',
      requestId: auth.requestId,
    });
  }
});

/**
 * Agent update endpoint
 * PUT /agents/:agentId
 * JWT authentication required
 */
router.put('/:agentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const result = resolveUserId(auth, req);
    const agentId = isAgentId(req.params.agentId) ? parseAgentId(req.params.agentId) : undefined;
    const input: Partial<CreateAgentInput> = req.body;

    if ('error' in result) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: result.error,
        requestId: auth.requestId,
      });
    }

    const { userId } = result;

    if (!agentId) {
      return res.status(400).json({
        error: 'Invalid request',
        message: `Agent ID format is invalid (must be a UUID): "${req.params.agentId}"`,
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        username: auth.username,
        agentId,
      },
      'Agent update started (%s):',
      auth.requestId
    );

    const agentsService = createAgentsService();
    const updateInput: UpdateAgentInput = {
      agentId,
      ...input,
    };
    const agent = await agentsService.updateAgent(userId, updateInput);

    logger.info('Agent update completed (%s): %s', auth.requestId, agent.name);

    res.status(200).json({
      agent: agent,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Agent update error (%s):', auth.requestId);

    if (error instanceof Error && error.message === 'Agent not found') {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Agent not found',
        requestId: auth.requestId,
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to update Agent',
      requestId: auth.requestId,
    });
  }
});

/**
 * Agent deletion endpoint
 * DELETE /agents/:agentId
 * JWT authentication required
 */
router.delete('/:agentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;
    const agentId = isAgentId(req.params.agentId) ? parseAgentId(req.params.agentId) : undefined;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    if (!agentId) {
      return res.status(400).json({
        error: 'Invalid request',
        message: `Agent ID format is invalid (must be a UUID): "${req.params.agentId}"`,
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        username: auth.username,
        agentId,
      },
      'Agent deletion started (%s):',
      auth.requestId
    );

    const agentsService = createAgentsService();
    await agentsService.deleteAgent(userId, agentId);

    logger.info('Agent deletion completed (%s): %s', auth.requestId, agentId);

    res.status(200).json({
      success: true,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Agent deletion error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to delete Agent',
      requestId: auth.requestId,
    });
  }
});

/**
 * Agent share status toggle endpoint
 * PUT /agents/:agentId/share
 * JWT authentication required
 */
router.put(
  '/:agentId/share',

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const userId = auth.userId ? parseUserId(auth.userId) : undefined;
      const agentId = isAgentId(req.params.agentId) ? parseAgentId(req.params.agentId) : undefined;

      if (!userId) {
        return res.status(400).json({
          error: 'Invalid authentication',
          message: 'Failed to retrieve user ID',
          requestId: auth.requestId,
        });
      }

      if (!agentId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: `Agent ID format is invalid (must be a UUID): "${req.params.agentId}"`,
          requestId: auth.requestId,
        });
      }

      logger.info(
        {
          userId,
          username: auth.username,
          agentId,
        },
        'Agent share status toggle started (%s):',
        auth.requestId
      );

      const agentsService = createAgentsService();
      const agent = await agentsService.toggleShare(userId, agentId);

      logger.info(
        'Agent share status toggle completed (%s): isShared=%s',
        auth.requestId,
        agent.isShared
      );

      res.status(200).json({
        agent: agent,
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          userId,
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error({ err: error }, 'Agent share status toggle error (%s):', auth.requestId);

      if (error instanceof Error && error.message === 'Agent not found') {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Agent not found',
          requestId: auth.requestId,
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to change Agent share status',
        requestId: auth.requestId,
      });
    }
  }
);

/**
 * Default Agent initialization endpoint
 * POST /agents/initialize
 * JWT authentication required
 * Create default Agents on first login
 */
router.post('/initialize', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const auth = getCurrentAuth(req);
    const userId = auth.userId ? parseUserId(auth.userId) : undefined;

    if (!userId) {
      return res.status(400).json({
        error: 'Invalid authentication',
        message: 'Failed to retrieve user ID',
        requestId: auth.requestId,
      });
    }

    logger.info(
      {
        userId,
        username: auth.username,
      },
      'Default Agent initialization started (%s):',
      auth.requestId
    );

    const agentsService = createAgentsService();

    // Check if existing Agents exist
    const existingAgents = await agentsService.listAgents(userId);

    if (existingAgents.length > 0) {
      logger.info('ℹ️  Skipping initialization because existing Agents exist (%s)', auth.requestId);
      return res.status(200).json({
        agents: existingAgents,
        skipped: true,
        message: 'Initialization skipped because existing Agents exist',
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          userId,
          count: existingAgents.length,
        },
      });
    }

    // Create default Agents
    const agents = await agentsService.initializeDefaultAgents(
      userId,
      DEFAULT_AGENTS,
      auth.username
    );

    logger.info(
      'Default Agent initialization completed (%s): %d items',
      auth.requestId,
      agents.length
    );

    res.status(201).json({
      agents: agents,
      skipped: false,
      metadata: {
        requestId: auth.requestId,
        timestamp: new Date().toISOString(),
        userId,
        count: agents.length,
      },
    });
  } catch (error) {
    const auth = getCurrentAuth(req);
    logger.error({ err: error }, 'Default Agent initialization error (%s):', auth.requestId);

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to initialize default Agents',
      requestId: auth.requestId,
    });
  }
});

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

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const { q: searchQuery, limit, cursor } = req.query;

      logger.info(
        {
          searchQuery,
          limit,
          hasCursor: !!cursor,
        },
        'Shared Agent list retrieval started (%s):',
        auth.requestId
      );

      const agentsService = createAgentsService();
      const result = await agentsService.listSharedAgents(
        limit ? parseInt(limit as string, 10) : 20,
        searchQuery as string | undefined,
        cursor as string | undefined
      );

      logger.info(
        'Shared Agent list retrieval completed (%s): %d items',
        auth.requestId,
        result.items.length
      );

      res.status(200).json({
        agents: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          count: result.items.length,
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error({ err: error }, 'Shared Agent list retrieval error (%s):', auth.requestId);

      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to retrieve shared Agent list',
        requestId: auth.requestId,
      });
    }
  }
);

/**
 * Shared Agent detail retrieval endpoint
 * GET /shared-agents/:userId/:agentId
 * JWT authentication required
 * All agents (including system defaults) are stored in DynamoDB.
 */
router.get(
  '/shared-agents/:userId/:agentId',

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const { userId, agentId } = req.params;

      if (!userId || !agentId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'User ID or Agent ID is not specified',
          requestId: auth.requestId,
        });
      }

      if (!isUserId(userId) || !isAgentId(agentId)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'User ID or Agent ID format is invalid (must be UUIDs)',
          requestId: auth.requestId,
        });
      }

      logger.info(
        {
          userId,
          agentId,
        },
        'Shared Agent detail retrieval started (%s):',
        auth.requestId
      );

      const agentsService = createAgentsService();
      const agent = await agentsService.getSharedAgent(parseUserId(userId), parseAgentId(agentId));

      if (!agent) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Shared Agent not found',
          requestId: auth.requestId,
        });
      }

      logger.info('Shared Agent detail retrieval completed (%s): %s', auth.requestId, agent.name);

      res.status(200).json({
        agent: agent,
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error({ err: error }, 'Shared Agent detail retrieval error (%s):', auth.requestId);

      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to retrieve shared Agent details',
        requestId: auth.requestId,
      });
    }
  }
);

/**
 * Shared Agent clone endpoint
 * POST /shared-agents/:userId/:agentId/clone
 * JWT authentication required
 * All agents (including system defaults) are cloned via the same path.
 */
router.post(
  '/shared-agents/:userId/:agentId/clone',

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const auth = getCurrentAuth(req);
      const targetUserId = auth.userId ? parseUserId(auth.userId) : undefined;
      const { userId: sourceUserId, agentId: sourceAgentId } = req.params;

      if (!targetUserId) {
        return res.status(400).json({
          error: 'Invalid authentication',
          message: 'Failed to retrieve user ID',
          requestId: auth.requestId,
        });
      }

      if (!sourceUserId || !sourceAgentId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Source User ID or Agent ID is not specified',
          requestId: auth.requestId,
        });
      }

      if (!isUserId(sourceUserId) || !isAgentId(sourceAgentId)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Source User ID or Agent ID format is invalid (must be UUIDs)',
          requestId: auth.requestId,
        });
      }

      logger.info(
        {
          targetUserId,
          targetUsername: auth.username,
          sourceUserId,
          sourceAgentId,
        },
        'Shared Agent clone started (%s):',
        auth.requestId
      );

      const agentsService = createAgentsService();
      const clonedAgent = await agentsService.cloneAgent(
        targetUserId,
        parseUserId(sourceUserId),
        parseAgentId(sourceAgentId),
        auth.username
      );

      logger.info('Shared Agent clone completed (%s): %s', auth.requestId, clonedAgent.agentId);

      res.status(201).json({
        agent: clonedAgent,
        metadata: {
          requestId: auth.requestId,
          timestamp: new Date().toISOString(),
          userId: targetUserId,
        },
      });
    } catch (error) {
      const auth = getCurrentAuth(req);
      logger.error({ err: error }, 'Shared Agent clone error (%s):', auth.requestId);

      if (error instanceof Error && error.message === 'Shared agent not found') {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Shared Agent not found',
          requestId: auth.requestId,
        });
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to clone shared Agent',
        requestId: auth.requestId,
      });
    }
  }
);

export default router;
