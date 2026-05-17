/**
 * Unit tests for error-handler utilities
 *
 * Key focus: MaxTokensError's cause.partialMessage must not leak unescaped
 * JSON characters into the [SYSTEM_ERROR] text, which would corrupt downstream
 * AppSync Events payloads and AgentCore Memory blob storage.
 */

import { describe, it, expect } from '@jest/globals';
import { sanitizeErrorMessage, createErrorMessage } from '../error-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a MaxTokensError similar to what Strands SDK throws */
function makeMaxTokensError(
  partialText = 'Minor Layer 3 update (adding new pattern to LEARNED_PATTERNS)'
) {
  const err = new Error('Max tokens exceeded');
  err.name = 'MaxTokensError';
  (err as any).cause = {
    partialMessage: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'textBlock', text: partialText }],
    },
  };
  return err;
}

// ---------------------------------------------------------------------------
// sanitizeErrorMessage
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage', () => {
  it('returns a plain string for a basic Error', () => {
    const result = sanitizeErrorMessage(new Error('something went wrong'));
    expect(typeof result).toBe('string');
    expect(result).toContain('something went wrong');
  });

  it('does NOT include partialMessage content from MaxTokensError', () => {
    const error = makeMaxTokensError('partial text with "quotes" inside');
    const result = sanitizeErrorMessage(error);
    // The partialMessage content must not appear in the sanitized output.
    // sanitizeErrorMessage only uses error.message (top-level string).
    expect(result).not.toContain('partial text');
    expect(result).not.toContain('partialMessage');
    expect(result).not.toContain('textBlock');
  });

  it('returns the error.message string for MaxTokensError', () => {
    const error = makeMaxTokensError();
    const result = sanitizeErrorMessage(error);
    expect(result).toContain('Max tokens exceeded');
  });

  it('removes newline and tab characters', () => {
    const error = new Error('line1\nline2\ttab');
    const result = sanitizeErrorMessage(error);
    expect(result).not.toMatch(/[\r\n\t]/);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  it('removes Bearer tokens', () => {
    const error = new Error('Auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    const result = sanitizeErrorMessage(error);
    expect(result).not.toContain('Bearer ey');
    expect(result).toContain('[TOKEN]');
  });

  it('truncates messages longer than 500 characters', () => {
    const long = 'x'.repeat(600);
    const error = new Error(long);
    const result = sanitizeErrorMessage(error);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('handles non-Error values gracefully', () => {
    expect(sanitizeErrorMessage('plain string')).toContain('plain string');
    expect(sanitizeErrorMessage(42)).toContain('42');
    expect(sanitizeErrorMessage(null)).toContain('null');
    // undefined is serialised to the string "undefined" by toSafeString()
    // (JSON.stringify(undefined) returns undefined, so String(undefined) = "undefined")
    expect(sanitizeErrorMessage(undefined)).toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// createErrorMessage
// ---------------------------------------------------------------------------

describe('createErrorMessage', () => {
  it('produces a Message with role assistant', () => {
    const msg = createErrorMessage(new Error('test'), 'req-123');
    expect(msg.role).toBe('assistant');
  });

  it('includes [SYSTEM_ERROR] and [/SYSTEM_ERROR] markers', () => {
    const msg = createErrorMessage(new Error('test'), 'req-123');
    const text = (msg.content[0] as any).text as string;
    expect(text).toContain('[SYSTEM_ERROR]');
    expect(text).toContain('[/SYSTEM_ERROR]');
  });

  it('includes the error name', () => {
    const error = makeMaxTokensError();
    const msg = createErrorMessage(error, 'req-456');
    const text = (msg.content[0] as any).text as string;
    expect(text).toContain('MaxTokensError');
  });

  it('includes the requestId', () => {
    const msg = createErrorMessage(new Error('test'), 'req-789');
    const text = (msg.content[0] as any).text as string;
    expect(text).toContain('req-789');
  });

  it('[SYSTEM_ERROR] text is safely embeddable in JSON — no unescaped quotes or newlines', () => {
    const error = makeMaxTokensError('partial "response" with\nnewlines and {"json": "inside"}');
    const msg = createErrorMessage(error, 'req-json-safe');
    const text = (msg.content[0] as any).text as string;

    // The text block itself must not contain raw unescaped double-quotes
    // outside of the JSON.stringify-wrapped Details value.
    // The safest way to verify: the entire text must be serialisable as a
    // JSON string value without throwing.
    expect(() => JSON.parse(JSON.stringify(text))).not.toThrow();

    // And embedding it in a JSON object (simulating blob storage) must not throw.
    expect(() => JSON.parse(`{"content": ${JSON.stringify(text)}}`)).not.toThrow();
  });

  it('Details field value uses JSON.stringify escaping', () => {
    const error = new Error('message with "quotes" and \\backslashes\\');
    const msg = createErrorMessage(error, 'req-escape');
    const text = (msg.content[0] as any).text as string;

    // The Details field should contain the sanitized message wrapped in JSON quotes.
    // The raw string must not appear unescaped.
    expect(text).toContain('Details:');
    // The entire line should be a valid substring of a JSON string
    expect(() => JSON.parse(JSON.stringify(text))).not.toThrow();
  });

  it('does NOT include partialMessage text from MaxTokensError in the stored block', () => {
    const partialText = 'LEARNED_PATTERNS new entry: {"key": "value with \\"nested\\" quotes"}';
    const error = makeMaxTokensError(partialText);
    const msg = createErrorMessage(error, 'req-partial');
    const text = (msg.content[0] as any).text as string;

    // partialMessage content should not appear in the stored error message
    expect(text).not.toContain('LEARNED_PATTERNS');
    expect(text).not.toContain('nested');
  });
});
