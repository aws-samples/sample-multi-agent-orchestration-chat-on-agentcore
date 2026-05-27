/**
 * Error handling utilities for AgentCore Runtime
 */

import { Message, TextBlock } from '@strands-agents/sdk';

// ---------------------------------------------------------------------------
// StreamInterruptedError — distinct error class for transient stream-cuts
// ---------------------------------------------------------------------------

/**
 * Thrown (or wrapped) when the upstream Bedrock streaming connection ends
 * before the model emits `messageStop`. Typical underlying causes:
 *
 * - Strands SDK throwing `ModelError("Stream ended without completing a message")`
 *   when the async iterator terminates early.
 * - AWS SDK v3 `IncompleteStreamException`.
 * - Low-level socket errors: `socket hang up`, `aborted`, `ECONNRESET`.
 *
 * Promoting these to a dedicated class lets the frontend (and operators
 * reading CloudWatch) distinguish a recoverable idle-disconnect from a
 * genuine model failure (validation, throttling, MaxTokensError, …).
 */
export class StreamInterruptedError extends Error {
  /** Always true for this class — a stream cut is by definition retryable. */
  readonly isRetryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'StreamInterruptedError';
    // Preserve prototype for `instanceof` to work across realms / transpiled
    // output where `extends Error` may otherwise be flattened.
    Object.setPrototypeOf(this, StreamInterruptedError.prototype);
  }
}

/**
 * Substring patterns that identify a stream-interruption error regardless of
 * which layer raised it. We match on `error.message` to avoid pulling in
 * SDK-specific class identities that aren't stable across SDK versions.
 */
const STREAM_INTERRUPTION_PATTERNS: readonly RegExp[] = [
  /stream ended without completing a message/i,
  /response stream was incomplete/i, // AWS SDK v3 IncompleteStreamException
  /incomplete stream/i,
  /socket hang ?up/i,
  /\baborted\b/i, // matches "aborted", "The operation was aborted"
  /ECONNRESET/,
];

/**
 * Inspect an error and, if it represents a transient stream cut, return a
 * `StreamInterruptedError` wrapping the original. Otherwise return the
 * input unchanged.
 *
 * - Pass-through for non-Error values and for unrelated errors (the caller
 *   keeps full identity / `instanceof` checks intact).
 * - The wrapped error preserves the original message verbatim so
 *   `sanitizeErrorMessage` and observability tooling still see the cause.
 */
export function classifyStreamError<T>(error: T): T | StreamInterruptedError {
  if (!(error instanceof Error)) {
    return error;
  }
  // Already classified — don't double-wrap.
  if (error instanceof StreamInterruptedError) {
    return error;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  const nameSignals = error.name === 'IncompleteStreamException';
  const messageSignals = STREAM_INTERRUPTION_PATTERNS.some((re) => re.test(message));

  if (nameSignals || messageSignals) {
    return new StreamInterruptedError(message || error.name, { cause: error });
  }
  return error;
}

/**
 * Convert an unknown value to a safe, printable string.
 *
 * - Strings pass through as-is.
 * - Objects are JSON-serialized so the output is human-readable.
 * - `undefined` and circular references fall back to `String()`.
 */
function toSafeString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    // JSON.stringify returns `undefined` for the JS value `undefined`,
    // so we need the nullish coalescing fallback.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Extract only the top-level message string from an error, explicitly
 * dropping any nested objects (e.g. cause.partialMessage from MaxTokensError)
 * that could introduce unescaped JSON characters when serialized.
 *
 * MaxTokensError from the Strands SDK carries a `cause.partialMessage` object
 * containing the partial assistant response. If `error.message` is an object
 * (some SDK errors serialize the whole payload as `message`), embedding it
 * verbatim into the [SYSTEM_ERROR] text would inject raw JSON — including
 * unescaped `"` characters — that corrupts downstream JSON parsing in
 * AppSync Events payloads and blob storage.
 */
function extractTopLevelMessage(error: unknown): unknown {
  if (error instanceof Error) {
    // Only use `message` if it is a plain string; otherwise fall back to
    // the error name to avoid embedding a JSON-serialised object.
    if (typeof error.message === 'string') {
      return error.message;
    }
    return error.name;
  }
  return error;
}

/**
 * Sanitize error message to remove sensitive information
 * @param error Error object or unknown value
 * @returns Sanitized error message safe for storage and display
 */
export function sanitizeErrorMessage(error: unknown): string {
  const rawMessage = extractTopLevelMessage(error);

  // AWS SDK v3 streaming errors (e.g. ModelStreamErrorException) may have a
  // non-string `message` property.  Safely convert to a printable string.
  // Note: JSON.stringify returns `undefined` (not a string) for `undefined` input,
  // so we must fall back to String() in that case.
  const message: string = toSafeString(rawMessage);

  // Remove sensitive information patterns
  return (
    message
      // Remove newlines and control characters that would break NDJSON framing
      // or introduce unexpected line splits in downstream JSON parsing.
      .replace(/[\r\n\t]/g, ' ')
      // Remove Bearer tokens
      .replace(/Bearer [A-Za-z0-9\-_.]+/gi, '[TOKEN]')
      // Remove AWS credentials and long alphanumeric strings (potential keys/secrets)
      .replace(/AKIA[A-Z0-9]{16}/g, '[AWS_KEY]')
      .replace(/[a-zA-Z0-9/+]{40,}/g, '[REDACTED]')
      // Remove file paths that might contain usernames
      .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
      .replace(/\/Users\/[^/\s]+/g, '/Users/[USER]')
      // Remove potential email addresses
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
      // Limit message length to prevent extremely long error messages
      .substring(0, 500)
  );
}

/**
 * Create error message for session storage
 * @param error Error object
 * @param requestId Request ID for tracking
 * @returns Message object formatted for storage
 */
export function createErrorMessage(error: unknown, requestId: string): Message {
  // Promote stream-interruption errors to StreamInterruptedError so that the
  // stored Type field reflects the *classified* name rather than the raw
  // SDK-internal `ModelError`. This lets operators searching CloudWatch
  // distinguish idle-disconnect from a genuine model failure.
  const classified = classifyStreamError(error);

  const errorName = classified instanceof Error ? classified.name : 'UnknownError';
  const sanitizedMessage = sanitizeErrorMessage(classified);

  // JSON.stringify the variable parts so that any remaining special characters
  // (quotes, backslashes, etc.) in the sanitized message are properly escaped.
  // This prevents the [SYSTEM_ERROR] text block from containing raw characters
  // that would corrupt JSON serialisation when stored in AgentCore Memory blobs
  // or published to AppSync Events — which was the root cause of the downstream
  // SyntaxError triggered by MaxTokensError's partialMessage content.
  const errorText =
    `[SYSTEM_ERROR] An error occurred. ` +
    `Type: ${errorName} ` +
    `Details: ${JSON.stringify(sanitizedMessage)} ` +
    `Request ID: ${requestId} ` +
    `[/SYSTEM_ERROR]`;

  return new Message({
    role: 'assistant',
    content: [new TextBlock(errorText)],
  });
}
