/**
 * Structured logger (pino-based)
 *
 * CloudWatch Logs treats each newline as a separate log event. Using
 * `console.log('msg', { ... })` causes Node's `util.inspect` to pretty-print
 * multi-line output, which shatters one logical log into many CloudWatch
 * events, breaking search / Logs Insights queries and inflating cost.
 *
 * pino emits one NDJSON line per log event, which CloudWatch ingests as
 * a single structured event. Each field (level, time, scope, requestId,
 * ...) becomes queryable via `fields @timestamp, scope, msg` etc.
 *
 * ## Output format
 *
 * - `NODE_ENV=development` (opt-in): `pino-pretty` colorized transport for
 *   local readability. `pino-pretty` is a **dev dependency**.
 * - Any other value — including `production`, `test`, or unset (which is
 *   the common case in AgentCore Runtime / Lambda containers): NDJSON to
 *   stdout. Defaulting to NDJSON avoids "unable to determine transport
 *   target for pino-pretty" crashes when the dev dep is absent in prod
 *   images.
 *
 * ## Call signature
 *
 * Use pino's native form:
 *   logger.info({ userId, count }, 'User created');
 *   logger.error({ err: error, requestId }, 'Request failed');
 *   logger.debug('Plain message');             // no merge object
 *   logger.info('Tool search completed: %d items (query: "%s")', n, q);  // printf
 *
 * Do NOT write `logger.info('msg', { obj })` — pino silently drops the
 * trailing object when the format string has no placeholders, and
 * `util.inspect`-expands it otherwise, reintroducing multi-line output.
 * The eslint rule `no-restricted-syntax` blocks this pattern.
 *
 * ## Scope / child loggers
 *
 * `createLogger('ServiceName')` returns a child logger whose output includes
 * `"scope":"ServiceName"`. This replaces ad-hoc `[ServiceName]` prefixes.
 */

import pino, { type Logger } from 'pino';

// Pretty output is OPT-IN (NODE_ENV=development). Any other value — including
// 'production', 'test', or unset (which is the common case in AgentCore
// Runtime / Lambda containers) — falls back to NDJSON on stdout. pino-pretty
// is a dev dependency and is NOT present in production images, so defaulting
// to pretty would crash at startup with "unable to determine transport target
// for pino-pretty".
const usePretty = process.env.NODE_ENV === 'development';
// LOG_LEVEL is validated by config/index.ts, but the logger must work
// before config parses (e.g. to report zod validation errors), so read
// the env var directly here.
const level = process.env.LOG_LEVEL ?? 'info';

export const logger: Logger = pino({
  level,
  // Auto-serialize Error objects under the `err` key (pino convention).
  serializers: {
    err: pino.stdSerializers.err,
  },
  // Redact sensitive fields automatically.
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'authorization',
      'Authorization',
      'req.headers.authorization',
      'headers.authorization',
      // Custom headers carrying credentials, redacted in pino-http access logs
      // that serialize request headers.
      'req.headers["x-amzn-bedrock-agentcore-runtime-custom-id-token"]',
      'req.headers["x-hub-signature-256"]',
      'jwt',
      '*.jwt',
      'apiKey',
      '*.apiKey',
      'api_key',
      '*.api_key',
      'accessToken',
      '*.accessToken',
      'access_token',
      '*.access_token',
      'refreshToken',
      '*.refreshToken',
      'refresh_token',
      '*.refresh_token',
      'idToken',
      '*.idToken',
      'id_token',
      '*.id_token',
      'openIdToken',
      '*.openIdToken',
      'clientSecret',
      '*.clientSecret',
      'client_secret',
      '*.client_secret',
      'secretAccessKey',
      '*.secretAccessKey',
      'sessionToken',
      '*.sessionToken',
    ],
    censor: '[REDACTED]',
  },
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

/**
 * Create a scoped child logger.
 *
 * @example
 *   const log = createLogger('AgentCoreMemoryService');
 *   log.info({ actorId }, 'Retrieving all sessions');
 */
export function createLogger(scope: string): Logger {
  return logger.child({ scope });
}

export type { Logger };
