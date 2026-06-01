/**
 * Request logging middleware (pino-http).
 *
 * Mounted once via `app.use(...)` BEFORE any router (and before `cors` /
 * `express.json`, so `req.log` exists even when those throw) so that every
 * request — including the no-auth `/webhooks`, `/ping`, `/`, 404s, and error
 * responses — gets:
 *   - a single structured access-log line (method, url, statusCode,
 *     responseTime, requestId, traceId) emitted automatically on response
 *     finish, and
 *   - `req.log`: a request-scoped child logger with `{ requestId }` (and, when
 *     available, `{ traceId }`) already bound (see `types/express.d.ts`). Route
 *     handlers log domain events via `req.log.info({ ...fields }, 'msg')` and no
 *     longer thread `requestId` through every message — replacing the per-route
 *     "started/completed" boilerplate that used to repeat in every handler.
 *
 * ## requestId ownership — aligned with API Gateway for cross-hop tracing
 *
 * This middleware OWNS request-id generation (previously done in
 * `authMiddleware`). Running before the routers, it assigns ONE id that is
 * shared by:
 *   - the access log and every `req.log` line (bound as `requestId`), and
 *   - the response envelope (`libs/http/responses.ts` reads `req.requestId`),
 *     and the `x-request-id` response header for client-side correlation.
 *
 * The backend runs as API Gateway (HTTP API v2) → Lambda + Lambda Web Adapter →
 * Express. The Web Adapter forwards the API Gateway event context as the
 * `x-amzn-request-context` header (JSON). We adopt that context's `requestId`
 * as our id so the Lambda's structured logs join up with the API Gateway access
 * logs (`$context.requestId`) on the SAME value — one grep spans both hops. We
 * deliberately do NOT trust a client-supplied `x-request-id` (it is forgeable
 * and would poison correlation); only the AWS-minted API Gateway id is honoured,
 * with a locally-generated `req_…` fallback for non-Lambda runs (local dev,
 * `app.listen`, tests).
 *
 * ## traceId — X-Ray end-to-end correlation
 *
 * The Web Adapter also forwards `x-amzn-trace-id` (`Root=1-…;Parent=…;Sampled=1`)
 * and the Lambda runtime exposes `_X_AMZN_TRACE_ID`. We extract the X-Ray `Root`
 * id and bind it as `traceId` on the access log and `req.log`, so a log line ties
 * to the X-Ray trace (ServiceLens) and the downstream AWS SDK calls on it. (Needs
 * Lambda Active Tracing enabled in CDK for the trace to be sampled/populated.)
 *
 * pino-http stores the id at `req.id` and, with `customAttributeKeys`, logs it
 * under the top-level `requestId` key — the SAME key the response body uses — so
 * a log and its response carry an identical, greppable `requestId`. The default
 * `req` serializer would ALSO emit that same value as `req.id`, so we wrap it to
 * drop `id` and avoid logging the request id twice per access-log line.
 *
 * The root `logger` (libs/logger) is reused as-is, inheriting its redaction,
 * `err` serializer, level, and NDJSON/pino-pretty transport decision. No second
 * pino instance is created.
 */

import { pinoHttp, stdSerializers } from 'pino-http';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import { logger } from '../libs/logger/index.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Fallback id scheme for non-Lambda runs, kept so `req_…` greps keep working. */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Read a header that may arrive as a string or string[]. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Extract the API Gateway `requestId` from the `x-amzn-request-context` header
 * that Lambda Web Adapter forwards (a JSON-encoded API GW v2 event context).
 * Returns undefined when absent or unparseable (local dev / direct HTTP), so the
 * caller falls back to a locally-minted id.
 */
function extractApiGatewayRequestId(req: IncomingMessage): string | undefined {
  const raw = headerValue(req, 'x-amzn-request-context');
  if (!raw) return undefined;
  try {
    const ctx = JSON.parse(raw) as { requestId?: unknown };
    return typeof ctx.requestId === 'string' ? ctx.requestId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the X-Ray trace id (the `Root=` segment) from the request's
 * `x-amzn-trace-id` header, falling back to the Lambda runtime's
 * `_X_AMZN_TRACE_ID` env var. Returns undefined when there is no trace context
 * (e.g. local dev without X-Ray), so `traceId` is simply omitted from the logs.
 */
export function extractTraceId(req: IncomingMessage): string | undefined {
  const raw = headerValue(req, 'x-amzn-trace-id') ?? process.env._X_AMZN_TRACE_ID;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('Root=')) return trimmed.slice('Root='.length);
  }
  return undefined;
}

export const requestLoggerMiddleware = pinoHttp({
  logger,
  // Bind the id under `requestId` (not pino-http's default `reqId`) so logs and
  // the response body share one key. `quietReqLogger` makes `req.log` a child
  // with `{ requestId }` bound, fulfilling the `req.log` contract in
  // types/express.d.ts.
  customAttributeKeys: { reqId: 'requestId' },
  quietReqLogger: true,
  // Drop the serializer's `req.id` — it duplicates the top-level `requestId`
  // bound by customAttributeKeys/quietReqLogger. Everything else (method, url,
  // headers, remoteAddress, ...) is preserved from the standard serializer.
  serializers: {
    req(req) {
      const serialized = stdSerializers.req(req);
      delete serialized.id;
      return serialized;
    },
  },
  // Own request-id generation. Prefer the AWS-minted API Gateway requestId (so
  // Lambda logs join the API GW access logs), else mint one locally. Mirror it
  // onto `req.requestId` (read by the response envelope) and the `x-request-id`
  // response header.
  genReqId: (req, res) => {
    const id = extractApiGatewayRequestId(req) ?? generateRequestId();
    (req as AuthenticatedRequest).requestId = id;
    res.setHeader('x-request-id', id);
    return id;
  },
  // Add the X-Ray traceId to the auto-emitted access-log (success/error) line.
  // `req.log` lines get it via `traceContextMiddleware` below.
  customProps: (req) => {
    const traceId = extractTraceId(req);
    return traceId ? { traceId } : {};
  },
  // Match the existing convention in error-handler.ts: 5xx/err → error,
  // 4xx → warn, else info.
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

/**
 * Bind `{ traceId }` onto `req.log` so EVERY domain log line (not just the
 * pino-http access line, which `customProps` already covers) carries the X-Ray
 * trace id. Mount immediately after `requestLoggerMiddleware`. No-op when there
 * is no trace context (local dev), keeping `req.log` unchanged.
 */
export function traceContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const traceId = extractTraceId(req);
  if (traceId) {
    req.log = req.log.child({ traceId });
  }
  next();
}
