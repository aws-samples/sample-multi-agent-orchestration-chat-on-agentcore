/**
 * Unit tests for CONVERSATION_WINDOW_SIZE config validation
 *
 * SlidingWindowConversationManager requires an even windowSize ≥ 2 to
 * guarantee that the first message after truncation is always 'user'.
 * Odd or too-small values cause assistant-first sequences → Bedrock
 * ValidationException.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { z } from 'zod';

/**
 * Isolated schema that mirrors the production CONVERSATION_WINDOW_SIZE definition.
 * We re-declare it here so that tests don't import the singleton `config`
 * (which parses process.env at import time and is hard to reset).
 */
const windowSizeSchema = z.coerce
  .number()
  .int({ message: 'CONVERSATION_WINDOW_SIZE must be an integer' })
  .min(2, { message: 'CONVERSATION_WINDOW_SIZE must be at least 2' })
  .refine((val) => val % 2 === 0, {
    message:
      'CONVERSATION_WINDOW_SIZE must be an even number to maintain user/assistant message ordering',
  })
  .default(40);

/** Parse helper that returns { success, data?, error? }. */
function parse(input?: unknown) {
  const result = windowSizeSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error.issues.map((i) => i.message) };
}

describe('CONVERSATION_WINDOW_SIZE validation', () => {
  describe('valid values', () => {
    it.each([
      { input: 2, expected: 2, label: 'minimum valid (2)' },
      { input: 4, expected: 4, label: 'small even (4)' },
      { input: 40, expected: 40, label: 'default (40)' },
      { input: 100, expected: 100, label: 'large even (100)' },
      { input: '20', expected: 20, label: 'string coerced to even number ("20")' },
      { input: '40', expected: 40, label: 'string coerced default ("40")' },
    ])('accepts $label → $expected', ({ input, expected }) => {
      const result = parse(input);
      expect(result.success).toBe(true);
      expect(result.data).toBe(expected);
    });

    it('uses default value (40) when input is undefined', () => {
      const result = parse(undefined);
      expect(result.success).toBe(true);
      expect(result.data).toBe(40);
    });
  });

  describe('invalid values — too small', () => {
    it.each([
      { input: 0, label: '0' },
      { input: 1, label: '1' },
      { input: -2, label: 'negative even (-2)' },
      { input: -1, label: 'negative odd (-1)' },
    ])('rejects $label', ({ input }) => {
      const result = parse(input);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('error message mentions minimum for 0', () => {
      const result = parse(0);
      expect(result.success).toBe(false);
      expect(result.errors!.join()).toMatch(/at least 2/);
    });

    it('error message mentions minimum for 1', () => {
      const result = parse(1);
      expect(result.success).toBe(false);
      expect(result.errors!.join()).toMatch(/at least 2/);
    });
  });

  describe('invalid values — odd numbers', () => {
    it.each([
      { input: 3, label: '3' },
      { input: 5, label: '5' },
      { input: 39, label: '39' },
      { input: 41, label: '41' },
      { input: 99, label: '99' },
    ])('rejects odd number $label', ({ input }) => {
      const result = parse(input);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.join()).toMatch(/even number/);
    });
  });

  describe('invalid values — non-numeric', () => {
    it.each([
      { input: 'abc', label: 'alphabetic string' },
      { input: '', label: 'empty string' },
      { input: 'true', label: 'boolean string' },
    ])('rejects $label', ({ input }) => {
      const result = parse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('invalid values — non-integer', () => {
    it.each([
      { input: 2.5, label: '2.5' },
      { input: 40.1, label: '40.1' },
      { input: '3.14', label: '"3.14"' },
    ])('rejects non-integer $label', ({ input }) => {
      const result = parse(input);
      expect(result.success).toBe(false);
      expect(result.errors!.join()).toMatch(/integer/);
    });
  });

  describe('integration with process.env pattern', () => {
    const originalEnv = process.env.CONVERSATION_WINDOW_SIZE;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.CONVERSATION_WINDOW_SIZE;
      } else {
        process.env.CONVERSATION_WINDOW_SIZE = originalEnv;
      }
    });

    it('parses env var string "20" as number 20', () => {
      process.env.CONVERSATION_WINDOW_SIZE = '20';
      const result = parse(process.env.CONVERSATION_WINDOW_SIZE);
      expect(result.success).toBe(true);
      expect(result.data).toBe(20);
    });

    it('rejects env var string "3" (odd)', () => {
      process.env.CONVERSATION_WINDOW_SIZE = '3';
      const result = parse(process.env.CONVERSATION_WINDOW_SIZE);
      expect(result.success).toBe(false);
    });

    it('uses default when env var is not set', () => {
      delete process.env.CONVERSATION_WINDOW_SIZE;
      const result = parse(undefined);
      expect(result.success).toBe(true);
      expect(result.data).toBe(40);
    });
  });
});
