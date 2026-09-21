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
 *     → validateInvocationMiddleware
 *     → authResolverMiddleware     (enrich ctx.userId / storagePath)
 *     → identityResolverMiddleware (UserId → IdentityId exchange)
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
  stopDispatchMiddleware,
  asyncHandler,
  validateInvocationMiddleware,
  authResolverMiddleware,
  identityResolverMiddleware,
  errorHandlerMiddleware,
  notFoundMiddleware,
  trackInFlightMiddleware,
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
  //   stopDispatch       → { action: 'stop' } → cancel in-flight turn + ack (short-circuit)
  //   validateInvocation → prompt / images → 400 on failure
  //   authResolver       → resolves branded UserId, enriches ctx.userId
  //   identityResolver   → exchanges UserId → IdentityId, caches on ctx
  //   handleInvocation   → business logic (reads ctx via require* helpers)
  //
  // `trackInFlight` runs first so the busy window covers the WHOLE request —
  // including auth/validation and any error response — and is released on the
  // response's 'finish'/'close'.
  //
  // `stopDispatch` runs after requestContext (it needs the authenticated
  // sessionId) but before validateInvocation (a stop carries no prompt, so it
  // must not be 400'd for that). It handles the out-of-band cancel command that
  // AgentCore's session-sticky routing delivers to this same microVM.
  app.post(
    '/invocations',
    trackInFlightMiddleware,
    requestContextMiddleware,
    stopDispatchMiddleware,
    validateInvocationMiddleware,
    authResolverMiddleware,
    identityResolverMiddleware,
    asyncHandler(handleInvocation)
  );

  // 404 must be registered after all routes
  app.use(notFoundMiddleware);

  // Global error handler — catches errors from asyncHandler and any middleware
  app.use(errorHandlerMiddleware);

  return app;
}
