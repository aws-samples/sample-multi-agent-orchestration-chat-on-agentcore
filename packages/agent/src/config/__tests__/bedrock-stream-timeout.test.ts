/**
 * Unit tests for BedrockModel stream-timeout configuration (issue #8).
 *
 * The Strands Agents SDK's `BedrockModel` defaults its underlying HTTP/2
 * `requestTimeout` to 120 s, which is too short for long agentic runs that
 * stream for several minutes. When the upstream Bedrock data plane (or any
 * intermediate proxy) idles the connection, the client receives a
 * `ModelError("Stream ended without completing a message")` ~10 minutes in.
 *
 * To mitigate the disconnect, `createBedrockModel()` must forward an explicit
 * `requestHandler: { requestTimeout, sessionTimeout }` to BedrockModel's
 * `clientConfig`.  The value comes from the new
 * `BEDROCK_STREAM_REQUEST_TIMEOUT_MS` env var (default 900_000 ms = 15 min).
 *
 * These tests intentionally re-declare the schema (mirroring the production
 * one in src/config/index.ts) rather than importing the global `config`
 * singleton, which parses process.env at import time and is hard to reset
 * between tests.
 */

import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';

const streamRequestTimeoutSchema = z.coerce
  .number()
  .int({ message: 'BEDROCK_STREAM_REQUEST_TIMEOUT_MS must be an integer' })
  .positive({ message: 'BEDROCK_STREAM_REQUEST_TIMEOUT_MS must be positive' })
  .default(900_000);

function parse(input?: unknown) {
  const result = streamRequestTimeoutSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: result.error.issues.map((i) => i.message) };
}

describe('BEDROCK_STREAM_REQUEST_TIMEOUT_MS schema', () => {
  it('defaults to 900_000 ms (15 minutes)', () => {
    const result = parse(undefined);
    expect(result.success).toBe(true);
    expect(result.data).toBe(900_000);
  });

  it('coerces a numeric string', () => {
    const result = parse('600000');
    expect(result.success).toBe(true);
    expect(result.data).toBe(600_000);
  });

  it('rejects zero and negative values', () => {
    expect(parse(0).success).toBe(false);
    expect(parse(-1).success).toBe(false);
    expect(parse('-5000').success).toBe(false);
  });

  it('rejects non-integer values', () => {
    expect(parse(1.5).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createBedrockModel — clientConfig.requestHandler propagation
// ---------------------------------------------------------------------------

import { jest } from '@jest/globals';

const mockBedrockModelCtor = jest.fn();

// `getMaxOutputTokens` is provided by @moca/core; we stub it to a constant
// so the test does not depend on per-model lookup tables.
jest.unstable_mockModule('@moca/core', () => ({
  getMaxOutputTokens: () => 8192,
}));

jest.unstable_mockModule('@strands-agents/sdk', () => ({
  BedrockModel: class {
    constructor(opts: any) {
      mockBedrockModelCtor(opts);
    }
  },
}));

jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The `config` module reads process.env at import time, so we mock it
// with a fixed object that contains the fields createBedrockModel reads.
jest.unstable_mockModule('../index.js', async () => ({
  config: {
    BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-6',
    BEDROCK_REGION: 'us-east-1',
    ENABLE_PROMPT_CACHING: false,
    BEDROCK_STREAM_REQUEST_TIMEOUT_MS: 900_000,
  },
}));

const { createBedrockModel } = await import('../bedrock.js');

describe('createBedrockModel — clientConfig.requestHandler', () => {
  beforeEach(() => {
    mockBedrockModelCtor.mockClear();
  });

  it('forwards a requestHandler with requestTimeout and sessionTimeout from config', () => {
    createBedrockModel();

    expect(mockBedrockModelCtor).toHaveBeenCalledTimes(1);
    const opts = mockBedrockModelCtor.mock.calls[0]![0] as any;

    expect(opts.clientConfig).toBeDefined();
    expect(opts.clientConfig.requestHandler).toBeDefined();
    expect(opts.clientConfig.requestHandler.requestTimeout).toBe(900_000);
    expect(opts.clientConfig.requestHandler.sessionTimeout).toBe(900_000);
  });

  it('preserves retryMode and maxAttempts in clientConfig', () => {
    createBedrockModel();

    const opts = mockBedrockModelCtor.mock.calls[0]![0] as any;
    expect(opts.clientConfig.retryMode).toBe('adaptive');
    expect(opts.clientConfig.maxAttempts).toBe(5);
  });
});
