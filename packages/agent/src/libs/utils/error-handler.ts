/**
 * Error handling utilities for AgentCore Runtime
 */

import { Message, TextBlock } from '@strands-agents/sdk';

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
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const sanitizedMessage = sanitizeErrorMessage(error);

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
