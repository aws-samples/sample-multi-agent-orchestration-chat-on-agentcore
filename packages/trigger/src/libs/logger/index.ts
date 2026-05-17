/**
 * Structured logger (pino-based) — trigger Lambda
 *
 * CloudWatch Logs treats each newline as a separate log event. Using
 * `console.log('msg', { ... })` causes Node's `util.inspect` to pretty-print
 * multi-line output, which shatters one logical log into many CloudWatch
 * events, breaking search / Logs Insights queries and inflating cost.
 *
 * pino emits one NDJSON line per log event, which CloudWatch ingests as
 * a single structured event. Each field (level, time, scope, requestId, ...)
 * becomes queryable via `fields @timestamp, scope, msg` etc.
 *
 * ## Output format
 *
 * - `NODE_ENV=development` (opt-in): `pino-pretty` colorized transport for
 *   local readability. `pino-pretty` is a **dev dependency**.
 * - Any other value — including `production`, `test`, or unset (which is
 *   the common case in Lambda containers): NDJSON to stdout.
 *
 * ## Call signature
 *
 * Use pino's native form:
 *   logger.info({ userId, count }, 'User created');
 *   logger.error({ err: error, requestId }, 'Request failed');
 *   logger.debug('Plain message');             // no merge object
 *
 * Do NOT write `logger.info('msg', { obj })` — pino silently drops the
 * trailing object when the format string has no placeholders, and
 * `util.inspect`-expands it otherwise, reintroducing multi-line output.
 * The eslint rule `no-restricted-syntax` blocks this pattern.
 *
 * ## Scope / child loggers
 *
 * `createLogger('ServiceName')` returns a child logger whose output includes
 * `"scope":"ServiceName"`.
 */

import pino, { type Logger } from 'pino';

const usePretty = process.env.NODE_ENV === 'development';
const level = process.env.LOG_LEVEL ?? 'info';

export const logger: Logger = pino({
  level,
  serializers: {
    err: pino.stdSerializers.err,
  },
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
 *   const log = createLogger('ScheduleHandler');
 *   log.info({ triggerId }, 'Dispatching trigger');
 */
export function createLogger(scope: string): Logger {
  return logger.child({ scope });
}

export type { Logger };
