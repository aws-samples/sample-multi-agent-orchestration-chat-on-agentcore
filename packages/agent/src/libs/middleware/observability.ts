/**
 * Observability middleware
 *
 * Wraps the downstream middleware chain in an OpenTelemetry span created
 * via `ObservabilityContext`. The span closes when the HTTP response
 * finishes, so streaming responses are measured end-to-end.
 *
 * Must run after `requestContextMiddleware` and `authResolverMiddleware`
 * so that `context.userId` is already populated.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/index.js';
import type { InvocationRequest } from '../../types/invocation-types.js';
import { ObservabilityContext } from '../context/observability-context.js';
import { getCurrentContext } from '../context/request-context.js';

/**
 * Name of the top-level span created for each `/invocations` request.
 */
const INVOCATION_SPAN_NAME = 'agent.invocation';

/**
 * Express middleware that wraps the rest of the chain in an OTel span.
 *
 * The span is kept open until one of `finish` / `close` / `error` fires on
 * the response so streaming responses are measured accurately.
 */
export function observabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const body = (req.body ?? {}) as InvocationRequest;
  const context = getCurrentContext();

  if (!context?.userId) {
    logger.error('observabilityMiddleware invoked before user resolution; skipping OTel span');
    next();
    return;
  }

  const otelCtx = new ObservabilityContext({
    actorId: context.userId,
    sessionId: context.sessionId,
    sessionType: context.sessionType,
    agentId: body.agentId,
    modelId: body.modelId,
    isMachineUser: context.isMachineUser,
    memoryEnabled: body.memoryEnabled,
  });

  // Drive `traceAsync` with a promise that resolves once the HTTP
  // response has been fully flushed. We never reject: errors are already
  // turned into HTTP responses by downstream middleware / the global
  // error handler, so we just observe the end of the lifecycle here.
  otelCtx
    .traceAsync(
      INVOCATION_SPAN_NAME,
      () =>
        new Promise<void>((resolve) => {
          const finalize = (): void => {
            res.removeListener('finish', finalize);
            res.removeListener('close', finalize);
            resolve();
          };
          res.once('finish', finalize);
          res.once('close', finalize);

          // Run `next()` inside the span's active context so all
          // downstream spans hang off of it.
          next();
        })
    )
    .catch((error) => {
      // `traceAsync` should not surface errors given the promise above
      // never rejects, but guard defensively to avoid an unhandled
      // rejection in edge cases.
      logger.error({ error }, 'Observability span unexpectedly rejected:');
    });
}
