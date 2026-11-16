/**
 * Backend API Server
 * Express API server with JWT authentication support
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { config, corsAllowedOrigins, listenAddress } from './config/index.js';
import { authMiddleware, AuthenticatedRequest, getCurrentAuth } from './middleware/auth.js';
import { errorHandlerMiddleware, notFoundMiddleware } from './middleware/error-handler.js';
import { hydrateJWKS } from './libs/auth/index.js';
import { requestLoggerMiddleware, traceContextMiddleware } from './middleware/request-logger.js';
import agentsRouter from './routes/agents.js';
import sessionsRouter from './routes/sessions.js';
import toolsRouter from './routes/tools.js';
import memoryRouter from './routes/memory.js';
import storageRouter from './routes/storage.js';
import triggersRouter from './routes/triggers.js';
import eventsRouter from './routes/events.js';
import webhooksRouter from './routes/webhooks.js';
import workflowsRouter from './routes/workflows.js';
import { createLogger } from './libs/logger/index.js';

const logger = createLogger('BackendServer');

const app = express();

/**
 * CORS configuration
 */
const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allowed?: boolean) => void
  ) => {
    const allowedOrigins = corsAllowedOrigins;

    // Allow if no origin (Postman, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Check wildcard (*) or explicitly allowed origins
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-amzn-bedrock-agentcore-runtime-custom-id-token',
  ],
  maxAge: 86400, // Preflight cache 24 hours
};

// Middleware configuration.
//
// Request logging is mounted FIRST — before `cors` and `express.json` — so that
// `req.log` and `req.requestId` are set on every request even when those
// middlewares reject it (a CORS-blocked origin or a malformed-JSON body throws
// and is routed straight to `errorHandlerMiddleware`, which logs via `req.log`).
// It also owns request-id generation (see request-logger.ts), and
// `traceContextMiddleware` binds the X-Ray `traceId` onto `req.log`.
app.use(requestLoggerMiddleware);
app.use(traceContextMiddleware);

app.use(cors(corsOptions));
// Per-user API responses must never be cached by CloudFront (it caches error
// statuses for 10s by default even without Cache-Control).
app.use((_req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(
  express.json({
    limit: '100mb',
  })
);

// API route configuration.
// `authMiddleware` verifies the JWT and (best-effort) resolves the Identity
// Pool identityId onto `req.identityId` for every protected router in one
// place; unauthenticated or ID-Token-less requests are rejected with 401.
app.use('/agents', authMiddleware, agentsRouter);
app.use('/sessions', authMiddleware, sessionsRouter);
app.use('/tools', authMiddleware, toolsRouter);
app.use('/memory', authMiddleware, memoryRouter);
app.use('/storage', authMiddleware, storageRouter);
app.use('/triggers', authMiddleware, triggersRouter);
app.use('/events', authMiddleware, eventsRouter);
app.use('/workflows', authMiddleware, workflowsRouter);
// `/webhooks` uses HMAC signature verification instead of JWT.
app.use('/webhooks', webhooksRouter);

/**
 * Health check endpoint (no authentication required)
 * Standard health check used by Lambda/API Gateway
 */
app.get('/ping', (req: Request, res: Response) => {
  const healthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'agentcore-backend',
    version: '0.1.0',
    environment: config.NODE_ENV,
    cognito: {
      configured: !!config.COGNITO_USER_POOL_ID,
      userPoolId: config.COGNITO_USER_POOL_ID ? '[CONFIGURED]' : null,
    },
  };

  res.status(200).json(healthStatus);
});

/**
 * JWT content verification endpoint (authentication required)
 * Return current JWT content
 */
app.get('/me', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const auth = getCurrentAuth(req);

  const response = {
    authenticated: auth.authenticated,
    user: {
      id: auth.userId,
      username: auth.username,
      email: auth.email,
      groups: auth.groups,
    },
    jwt: {
      tokenUse: auth.tokenUse,
      issuer: req.jwt?.iss,
      audience: req.jwt?.aud,
      issuedAt: req.jwt?.iat ? new Date(req.jwt.iat * 1000).toISOString() : null,
      expiresAt: req.jwt?.exp ? new Date(req.jwt.exp * 1000).toISOString() : null,
      clientId: req.jwt?.client_id,
      authTime: req.jwt?.auth_time ? new Date(req.jwt.auth_time * 1000).toISOString() : null,
    },
    request: {
      id: auth.requestId,
      timestamp: new Date().toISOString(),
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    },
  };

  res.status(200).json(response);
});

/**
 * Root endpoint (no authentication required)
 * Display API information
 */
app.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    service: 'AgentCore Backend API',
    version: '0.1.0',
    environment: config.NODE_ENV,
    endpoints: {
      health: 'GET /ping',
      userInfo: 'GET /me (requires Authorization header)',
    },
    documentation: {
      authentication: 'JWT Bearer token in Authorization header',
      format: 'Authorization: Bearer <jwt_token>',
    },
    timestamp: new Date().toISOString(),
  });
});

// 404 handler — must be registered after all routes.
app.use(notFoundMiddleware);

// Global error handler — renders the canonical envelope for anything thrown
// by the chain (AppError, ZodError, JSON parse errors, unexpected 500s).
app.use(errorHandlerMiddleware);

/** Upper bound for draining in-flight requests (matches the 30s request timeout). */
const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Start server
 */
async function startServer(): Promise<void> {
  try {
    const { host, port } = listenAddress;
    // Listen first: the Web Functions runtime fails init if the server is not
    // listening within 10s, and JWKS hydration is a network round trip.
    const server = app.listen(port, host, (err?: Error) => {
      if (err) {
        // Express 5 routes bind errors here instead of throwing.
        logger.error({ err, host, port }, 'Failed to bind HTTP server');
        process.exit(1);
      }
      logger.info(`AgentCore Backend API server listening on ${host}:${port}`);
      logger.info(`Environment: ${config.NODE_ENV}`);
      logger.info(`Cognito configured: ${config.COGNITO_USER_POOL_ID ? 'yes' : 'no'}`);
      logger.info(`CORS origins: ${corsAllowedOrigins.join(', ')}`);
    });

    // Pre-load JWKS cache for faster first verification (never throws)
    void hydrateJWKS();

    // Graceful shutdown: Web Functions send SIGTERM while draining an
    // environment, so let in-flight requests finish instead of exiting.
    const shutdown = (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      // A stuck request must not hold the process past the drain window.
      setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error({ err: error }, 'Server start failed:');
    process.exit(1);
  }
}

// Error handling on process termination
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught Exception:');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Rejection at:', promise, 'reason:');
  process.exit(1);
});

// Start server
startServer();
