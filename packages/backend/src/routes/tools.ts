/**
 * Tools API Routes
 * API providing tool list and search functionality for AgentCore Gateway.
 *
 * Handlers are wrapped in `asyncHandler` and signal failures by throwing
 * `AppError`; the global `errorHandlerMiddleware` renders the canonical error
 * envelope. Request bodies are validated by `validate(...)` middleware. This
 * router uses `auth.userId` (which may be undefined for machine users) only for
 * response metadata and reads the id token from the Authorization header.
 */

import express, { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest, getCurrentAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { gatewayService } from '../services/agentcore-gateway.js';
import { fetchToolsFromMCPConfig, MCPConfig, MCPConfigError } from '../libs/mcp/index.js';
import { allMCPToolDefinitions } from '@moca/tool-definitions';
import { createLogger } from '../libs/logger/index.js';
import { AppError, ErrorCode, ok } from '../libs/http/index.js';

const logger = createLogger('ToolsRoute');

const router = express.Router();

/**
 * Tool list retrieval endpoint (authentication required)
 * GET /tools
 */
router.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const auth = getCurrentAuth(req);
    const idToken = req.headers.authorization?.replace('Bearer ', '');

    if (!idToken) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication token is required');
    }

    logger.info(
      {
        userId: auth.userId,
        username: auth.username,
      },
      'Tool list retrieval started (%s):',
      auth.requestId
    );

    // Get cursor query parameter
    const cursor = req.query.cursor as string | undefined;

    // Fetch tool list from Gateway (authentication required, pagination supported)
    let result;
    try {
      result = await gatewayService.listTools(idToken, cursor);
    } catch (e) {
      // Return 502 (UPSTREAM_ERROR) for Gateway connection errors
      if (e instanceof Error && e.message.includes('Gateway')) {
        throw new AppError(ErrorCode.UPSTREAM_ERROR, e.message);
      }
      throw e;
    }

    // Include builtin tools only in the first page (when cursor is not present)
    const tools = cursor ? result.tools : [...allMCPToolDefinitions, ...result.tools];

    logger.info(
      {
        requestId: auth.requestId,
        total: tools.length,
        builtinCount: cursor ? 0 : allMCPToolDefinitions.length,
        gatewayCount: result.tools.length,
      },
      'Tool list retrieval completed',
      result.nextCursor ? { nextCursor: 'present' } : { nextCursor: 'none' }
    );

    res.status(200).json(
      ok(
        req,
        { tools, nextCursor: result.nextCursor },
        { actorId: auth.userId, count: tools.length }
      )
    );
  })
);

/**
 * Tool search endpoint
 * POST /tools/search
 */
router.post(
  '/search',
  validate({ body: z.object({ query: z.string().trim().min(1) }) }),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const auth = getCurrentAuth(req);
    const idToken = req.headers.authorization?.replace('Bearer ', '');
    const { query } = req.body;

    if (!idToken) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication token is required');
    }

    logger.info(
      {
        userId: auth.userId,
        username: auth.username,
        query: query.trim(),
      },
      'Tool search started (%s):',
      auth.requestId
    );

    const trimmedQuery = query.trim().toLowerCase();

    // Search in builtin tools (local search)
    const builtinResults = allMCPToolDefinitions.filter(
      (tool) =>
        tool.name.toLowerCase().includes(trimmedQuery) ||
        (tool.description && tool.description.toLowerCase().includes(trimmedQuery))
    );

    // Execute semantic search on Gateway for MCP tools
    let gatewayResults;
    try {
      gatewayResults = await gatewayService.searchTools(query.trim(), idToken);
    } catch (e) {
      // Return 502 (UPSTREAM_ERROR) for Gateway connection errors
      if (e instanceof Error && e.message.includes('Gateway')) {
        throw new AppError(ErrorCode.UPSTREAM_ERROR, e.message);
      }
      throw e;
    }

    // Combine builtin and gateway results
    const tools = [...builtinResults, ...gatewayResults];

    logger.info(
      `Tool search completed (${auth.requestId}): ${tools.length} items (builtin: ${builtinResults.length}, gateway: ${gatewayResults.length}, query: "${query.trim()}")`
    );

    res.status(200).json(
      ok(req, { tools }, { actorId: auth.userId, query: query.trim(), count: tools.length })
    );
  })
);

/**
 * Gateway connection check endpoint
 * GET /tools/health
 */
router.get(
  '/health',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const auth = getCurrentAuth(req);
    const idToken = req.headers.authorization?.replace('Bearer ', '');

    if (!idToken) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication token is required');
    }

    logger.info(
      {
        userId: auth.userId,
        username: auth.username,
      },
      'Gateway connection check started (%s):',
      auth.requestId
    );

    // Check Gateway connection
    const isConnected = await gatewayService.checkConnection(idToken);

    if (!isConnected) {
      logger.info('Gateway connection check failed (%s)', auth.requestId);
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Gateway is not reachable', {
        details: { gateway: { connected: false } },
      });
    }

    logger.info('Gateway connection check successful (%s)', auth.requestId);
    res.status(200).json(
      ok(
        req,
        {
          status: 'healthy',
          gateway: {
            connected: true,
            endpoint: '', // For security, actual endpoint is not displayed
          },
        },
        { actorId: auth.userId }
      )
    );
  })
);

/**
 * Local MCP tool retrieval endpoint
 * POST /tools/local
 * Retrieve tool list from user-defined MCP server configuration
 */
router.post(
  '/local',
  validate({
    body: z.object({
      mcpConfig: z.object({ mcpServers: z.record(z.string(), z.any()) }).passthrough(),
    }),
  }),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const auth = getCurrentAuth(req);
    const { mcpConfig } = req.body as { mcpConfig: MCPConfig };

    logger.info(
      {
        userId: auth.userId,
        serverCount: Object.keys(mcpConfig.mcpServers).length,
      },
      'Local MCP tool retrieval started (%s):',
      auth.requestId
    );

    // Fetch tool list from MCP servers
    let result;
    try {
      result = await fetchToolsFromMCPConfig(mcpConfig, logger);
    } catch (e) {
      if (e instanceof MCPConfigError) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, e.message);
      }
      throw e;
    }

    logger.info(
      `Local MCP tool retrieval completed (${auth.requestId}): ${result.tools.length} tools, ${result.errors.length} errors`
    );

    res.status(200).json(
      ok(
        req,
        { tools: result.tools, errors: result.errors },
        { actorId: auth.userId, count: result.tools.length, errorCount: result.errors.length }
      )
    );
  })
);

export default router;
