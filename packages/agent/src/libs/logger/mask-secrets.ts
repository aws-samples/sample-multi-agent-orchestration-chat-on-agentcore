/**
 * Secret-masking helpers for structured logs
 *
 * ## Why this module exists
 *
 * The Strands Agents SDK's `AgentPrinter` (disabled via `printer: false` in
 * `agent.ts`) formerly wrote every text delta, reasoning block, and tool-use
 * line to `process.stdout`. Because the platform captures the process's stdout
 * as CloudWatch Logs, all assistant response text, reasoning, and prompt
 * content landed in the log stream in plain text, which may include
 * user-supplied secrets.
 *
 * With `printer: false`, the SDK no longer writes to stdout. This module
 * handles the controlled, opt-in re-introduction of content in pino-structured
 * form when `LOG_CONTENT=true`:
 *
 *   - `maskSecrets()` — redact common patterns before writing any content.
 *   - `maskCommand()` — redact + truncate shell command strings.
 *   - `summarizeContent()` — by default return only the character count;
 *     when `LOG_CONTENT_ENABLED` is true return the masked content as well.
 *
 * ## Patterns masked
 *
 * | Pattern | Example |
 * |---------|---------|
 * | AWS access key ID | `AKIA` followed by 16 uppercase alphanumerics |
 * | AWS access key (long-form key=val) | `aws_access_key_id=AKIA…` |
 * | AWS secret access key | `aws_secret_access_key=…` |
 * | Authorization header value | `Authorization: Bearer eyJ…` |
 * | `-pass` / `pass:` | `openssl enc -pass pass:hunter2` |
 * | `--password` flag | `mysql --password=s3cr3t` |
 * | `password=` / `secret=` / `token=` | query-string or env-style |
 *
 * The list is intentionally conservative: it covers well-known, unambiguous
 * patterns. Arbitrary key=value pairs are NOT masked — doing so would strip
 * useful diagnostic context. Tool input arguments are intentionally NOT logged
 * even when `LOG_CONTENT=true` because they may contain user-supplied secrets
 * that no static pattern can fully cover.
 *
 * ## `LOG_CONTENT` opt-in
 *
 * Set `LOG_CONTENT=true` in the container's environment variables to enable
 * content logging. The default is off, which means only character counts are
 * written to the log stream. Enable only in non-production environments or
 * when actively debugging.
 */

/** True when `LOG_CONTENT=true` is set in the environment. */
export const LOG_CONTENT_ENABLED: boolean = process.env.LOG_CONTENT === 'true';

// ── Secret patterns ────────────────────────────────────────────────────────

/**
 * Each entry is [pattern, replacement].
 * Patterns are anchored to avoid false-positive matches inside base64 blobs.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // AWS IAM access key IDs (AKIA/ASIA prefix, 16 upper-alpha-numeric chars)
  [/((?:AKIA|ASIA)[A-Z0-9]{16})/g, '[AWS_KEY_ID]'],
  // aws_access_key_id = … (env / config file style)
  [/(aws_access_key_id\s*=\s*)[^\s&"']+/gi, '$1[REDACTED]'],
  // aws_secret_access_key = …
  [/(aws_secret_access_key\s*=\s*)[^\s&"']+/gi, '$1[REDACTED]'],
  // Authorization: Bearer <token>  (also Basic, Token)
  [/(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"'\\]+/gi, '$1[REDACTED]'],
  // -pass pass:<value>  or  -pass file:…  (openssl / curl)
  [/(-pass(?:wd)?\s+pass:)[^\s"']+/g, '$1[REDACTED]'],
  // --password[=\s]<value>
  [/(--password(?:=|\s+))[^\s"'&]+/g, '$1[REDACTED]'],
  // password=<value>  (query string / env-style key=value)
  [/(password=)[^\s&"'\\]+/gi, '$1[REDACTED]'],
  // secret=<value>
  [/(secret=)[^\s&"'\\]+/gi, '$1[REDACTED]'],
  // token=<value>  — intentionally scoped to `token=` prefix only to avoid
  // over-matching hex/base64 tokens that appear elsewhere in URLs
  [/((?:^|[&?;,\s])token=)[^\s&"'\\]+/gi, '$1[REDACTED]'],
];

/**
 * Maximum command length written to the log.
 * Commands longer than this are truncated to prevent huge log events.
 */
const MAX_COMMAND_LOG_CHARS = 300;

// ── Public helpers ─────────────────────────────────────────────────────────

/**
 * Apply all secret patterns to `text` and return the redacted string.
 * Safe to call with an empty string; always returns a string.
 */
export function maskSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Mask secrets in a shell command string and truncate to
 * {@link MAX_COMMAND_LOG_CHARS} characters for log safety.
 */
export function maskCommand(command: string): string {
  const masked = maskSecrets(command);
  if (masked.length <= MAX_COMMAND_LOG_CHARS) return masked;
  return `${masked.slice(0, MAX_COMMAND_LOG_CHARS)}…(truncated)`;
}

/**
 * Build a log-safe summary object for a content string.
 *
 * - **Always** includes the character count under `${label}Chars`.
 * - When {@link LOG_CONTENT_ENABLED} is `true`, also includes the masked
 *   content under `label`.
 *
 * @example
 *   logger.info(summarizeContent(prompt, 'prompt'), 'Request received:');
 *   // LOG_CONTENT=false → { promptChars: 42 }
 *   // LOG_CONTENT=true  → { prompt: 'Hello …', promptChars: 42 }
 */
export function summarizeContent(
  text: string,
  label: string
): Record<string, string | number> {
  const chars = text?.length ?? 0;
  if (LOG_CONTENT_ENABLED) {
    return { [label]: maskSecrets(text ?? ''), [`${label}Chars`]: chars };
  }
  return { [`${label}Chars`]: chars };
}
