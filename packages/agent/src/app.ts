/**
 * Express application factory for AgentCore Runtime
 *
 * Wires together cross-cutting middlewares — CORS, JSON parser,
 * per-request context, invocation validation, auth resolution and
 * observability — so route handlers can focus on the happy path.
 *
 * Middleware chain for `POST /invocations`:
 *
 *   cors → json
 *     → requestContextMiddleware   (AsyncLocalStorage-backed ctx)
 *     → validateInvocationMiddleware
 *     → authResolverMiddleware     (enrich ctx.userId / storagePath)
 *     → observabilityMiddleware    (OTel span wrapping the request)
 *     → handleInvocation           (business logic, wrapped in asyncHandler)
 *
 * The global `errorHandlerMiddleware` catches anything thrown by the
 * chain (including rejected promises bubbled up by `asyncHandler`).
 */

import express, { Express } from 'express';
import cors from 'cors';
import {
  corsOptions,
  requestContextMiddleware,
  asyncHandler,
  validateInvocationMiddleware,
  authResolverMiddleware,
  identityResolverMiddleware,
  observabilityMiddleware,
  errorHandlerMiddleware,
  notFoundMiddleware,
} from './libs/middleware/index.js';
import { handleInvocation, handlePing, handleRoot } from './handlers/index.js';

/**
 * Create and configure Express application
 * @returns Configured Express application
 */
export function createApp(): Express {
  const app = express();

  // Base middlewares (apply to every route)
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '100mb' }));

  // Routes that don't need auth
  app.get('/ping', handlePing);
  app.get('/', handleRoot);

  // `/invocations` gets the full auth / validation / observability chain.
  //
  //   requestContext     → AsyncLocalStorage ctx + JWT parse + session headers
  //   validateInvocation → prompt / images → 400 on failure
  //   authResolver       → resolves branded UserId, enriches ctx.userId
  //   identityResolver   → exchanges UserId → IdentityId, caches on ctx
  //   observability      → OTel span wrapping the remaining chain
  //   handleInvocation   → business logic (reads ctx via require* helpers)
  app.post(
    '/invocations',
    requestContextMiddleware,
    validateInvocationMiddleware,
    authResolverMiddleware,
    identityResolverMiddleware,
    observabilityMiddleware,
    asyncHandler(handleInvocation)
  );

  // 404 must be registered after all routes
  app.use(notFoundMiddleware);

  // Global error handler — catches errors from asyncHandler and any middleware
  app.use(errorHandlerMiddleware);

  return app;
}
