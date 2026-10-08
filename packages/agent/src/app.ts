/**
 * Express application factory for AgentCore Runtime
 *
 * Wires together cross-cutting middlewares — CORS, JSON parser,
 * per-request context, invocation validation, and auth resolution —
 * so route handlers can focus on the happy path.
 *
 * Middleware chain for `POST /invocations`:
 *
 *   cors → json
 *     → requestContextMiddleware   (AsyncLocalStorage-backed ctx)
 *     → authResolverMiddleware     (enrich ctx.userId / storagePath)
 *     → identityResolverMiddleware (UserId → IdentityId exchange)
 *     → warmupMiddleware           (`{ warmup: true }` → 200 + workspace prefetch, no agent work)
 *     → validateInvocationMiddleware
 *     → handleInvocation           (business logic, wrapped in asyncHandler)
 *
 * Tracing is left to the Strands SDK's own `invoke_agent` span (with
 * custom attributes injected via `traceAttributes` in `agent.ts`) plus
 * the surrounding ADOT auto-instrumentation HTTP span. Inserting a
 * custom span between those two breaks AgentCore Observability's
 * trace-level token aggregation, so we deliberately don't add one.
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
  errorHandlerMiddleware,
  notFoundMiddleware,
  trackInFlightMiddleware,
  warmupMiddleware,
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

  // `/invocations` gets the full auth / validation chain.
  //
  //   trackInFlight      → mark container busy so /ping reports HealthyBusy
  //   requestContext     → AsyncLocalStorage ctx + JWT parse + session headers
  //   authResolver       → resolves branded UserId, enriches ctx.userId
  //   identityResolver   → exchanges UserId → IdentityId, caches on ctx
  //   warmup             → `{ warmup: true }` → 200 { status: 'warm' } (+ workspace prefetch)
  //   validateInvocation → prompt / images → 400 on failure
  //   handleInvocation   → business logic (reads ctx via require* helpers)
  //
  // `trackInFlight` runs first so the busy window covers the WHOLE request —
  // including auth/validation and any error response — and is released on the
  // response's 'finish'/'close', which also catches a client abort mid-stream.
  app.post(
    '/invocations',
    trackInFlightMiddleware,
    requestContextMiddleware,
    authResolverMiddleware,
    identityResolverMiddleware,
    warmupMiddleware,
    validateInvocationMiddleware,
    asyncHandler(handleInvocation)
  );

  // 404 must be registered after all routes
  app.use(notFoundMiddleware);

  // Global error handler — catches errors from asyncHandler and any middleware
  app.use(errorHandlerMiddleware);

  return app;
}
