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
 * ## requestId ownership — the Lambda-minted id, shared with the client
 *
 * This middleware OWNS request-id generation (previously done in
 * `authMiddleware`). Running before the routers, it assigns ONE id that is
 * shared by:
 *   - the access log and every `req.log` line (bound as `requestId`), and
 *   - the response envelope (`libs/http/responses.ts` reads `req.requestId`),
 *     and the `x-request-id` response header for client-side correlation.
 *
 * The backend runs as CloudFront → Lambda Web Function → Express. Lambda adds a
 * `lambda-web-request-id` header to every forwarded request and returns the
 * same value as a response header, so adopting it as our id lets a client-side
 * response header, the Lambda platform logs and our structured logs join up on
 * one value. We deliberately do NOT trust a client-supplied `x-request-id` (it
 * is forgeable and would poison correlation); only the Lambda-minted id is
 * honoured (verified: Lambda replaces any client-sent `lambda-web-request-id`
 * with its own), with a locally-generated `req_…` fallback for non-Lambda runs
 * (local dev, tests).
 *
 * ## traceId — X-Ray end-to-end correlation
 *
 * When a caller sends `x-amzn-trace-id` (`Root=1-…;Parent=…;Sampled=1`), we
 * extract the X-Ray `Root` id and bind it as `traceId` on the access log and
 * `req.log`, so a server-side caller that propagates its trace (e.g. AgentCore
 * Runtime) can be joined to these lines. Nothing in front of the app mints or
 * overwrites this header, so treat `traceId` as caller-supplied correlation
 * only — `requestId` is the authoritative, Lambda-minted id. There is
 * deliberately no `_X_AMZN_TRACE_ID` env fallback: Web Functions serve many
 * concurrent requests per process, so an env value would stamp one stale id on
 * unrelated requests.
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
 * The Lambda Web Functions request id (`lambda-web-request-id` header).
 * Undefined outside Lambda (local dev / tests), so the caller falls back to a
 * locally-minted id.
 */
function extractLambdaWebRequestId(req: IncomingMessage): string | undefined {
  return headerValue(req, 'lambda-web-request-id') || undefined;
}

/**
 * Extract the X-Ray trace id (the `Root=` segment) from the request's
 * `x-amzn-trace-id` header. Returns undefined when absent, so `traceId` is
 * simply omitted from the logs.
 */
export function extractTraceId(req: IncomingMessage): string | undefined {
  const raw = headerValue(req, 'x-amzn-trace-id');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('Root=')) return trimmed.slice('Root='.length);
  }
  return undefined;
}

/**
 * Drop CloudFront-added `cloudfront-*` headers from the logged request.
 * The origin request policy must forward all viewer headers (an allow-list
 * would cap at 10 and silently break webhooks/CORS), and CloudFront then also
 * injects ~20 `CloudFront-Viewer-*` headers — city, latitude, postal code, ...
 * Logging them would store per-request location PII and roughly double each
 * access-log line. The app never reads them.
 */
export function omitCloudFrontHeaders<T extends Record<string, unknown>>(headers: T): T {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !name.toLowerCase().startsWith('cloudfront-'))
  ) as T;
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
      serialized.headers = omitCloudFrontHeaders(serialized.headers);
      return serialized;
    },
  },
  // Own request-id generation. Prefer the Lambda-minted request id (also
  // returned to the client as a response header), else mint one locally. Mirror it
  // onto `req.requestId` (read by the response envelope) and the `x-request-id`
  // response header.
  genReqId: (req, res) => {
    const id = extractLambdaWebRequestId(req) ?? generateRequestId();
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
