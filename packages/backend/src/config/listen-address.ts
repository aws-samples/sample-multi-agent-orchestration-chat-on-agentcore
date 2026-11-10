/**
 * Parse the `host:port` value of `AWS_LAMBDA_HTTP_ENDPOINT`.
 *
 * Throws instead of guessing: an unparseable value would otherwise make the
 * server listen somewhere Lambda never routes to, which surfaces only as a
 * 10s init timeout on every cold start.
 */
export function parseHttpEndpoint(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value.trim());
  const port = match ? Number(match[3]) : NaN;
  if (!match || port < 1 || port > 65535) {
    throw new Error(`Invalid AWS_LAMBDA_HTTP_ENDPOINT "${value}" (expected host:port)`);
  }
  return { host: match[1] ?? match[2], port };
}
