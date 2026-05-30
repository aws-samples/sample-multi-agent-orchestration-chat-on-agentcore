/**
 * Structured-logging assertions for StreamTerminationRetryStrategy.
 *
 * Why a separate file?  The companion `stream-termination-retry-strategy.test.ts`
 * exercises the *behaviour* (classification + the real SDK retry loop). Here we
 * assert the *observability contract*: the stable `msg` keys, log levels, and the
 * structured fields (`attempt`, `maxAttempts`, `willRetry`, `kind`, `err`) that
 * downstream CloudWatch Logs Insights queries depend on.
 *
 * We mock the scoped logger module via `jest.unstable_mockModule` and inspect the
 * mock's call arguments directly. This is deterministic and CI-safe — unlike
 * capturing `process.stdout`, whose pino write semantics differ between local and
 * CI runners and previously produced a flaky test.
 *
 * ESM note: mocks MUST be registered before the dynamic `import()` of the module
 * under test, matching the pattern used in handlers/__tests__/stream-handler.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Single shared logger mock returned by createLogger(); the strategy binds it at
// module-eval time via `const log = createLogger('StreamTerminationRetryStrategy')`.
const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  createLogger: jest.fn(() => mockLog),
  logger: mockLog,
}));

// No active request context in unit scope → currentRequestId() returns undefined.
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: jest.fn(() => undefined),
}));

const { ModelError, MaxTokensError } = await import('@strands-agents/sdk');
const { StreamTerminationRetryStrategy, STREAM_INCOMPLETE_MESSAGE } = await import(
  '../stream-termination-retry-strategy.js'
);

const truncation = () => new ModelError(STREAM_INCOMPLETE_MESSAGE);

describe('StreamTerminationRetryStrategy structured logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs stream_retry_classified at warn level with the retry context', () => {
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 3 });

    expect(s.isRetryable(truncation())).toBe(true);

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.error).not.toHaveBeenCalled();

    const [fields, msg] = mockLog.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('stream_retry_classified');
    expect(fields).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      willRetry: true,
      kind: 'stream_truncation',
    });
    expect((fields.err as Record<string, unknown>).message).toBe(STREAM_INCOMPLETE_MESSAGE);
    // name is propagated from the SDK error class; assert it is a non-empty
    // string rather than pinning the exact class name (SDK-implementation detail).
    expect(typeof (fields.err as Record<string, unknown>).name).toBe('string');
    expect((fields.err as Record<string, unknown>).name).toBeTruthy();
  });

  it('logs stream_retry_exhausted at error level once maxAttempts is reached', () => {
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 2 });

    s.isRetryable(truncation()); // attempt 1 → classified (warn)
    s.isRetryable(truncation()); // attempt 2 → exhausted (error)

    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledTimes(1);

    const [warnFields, warnMsg] = mockLog.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnMsg).toBe('stream_retry_classified');
    expect(warnFields).toMatchObject({ attempt: 1, maxAttempts: 2, willRetry: true });

    const [errFields, errMsg] = mockLog.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(errMsg).toBe('stream_retry_exhausted');
    expect(errFields).toMatchObject({
      attempt: 2,
      maxAttempts: 2,
      willRetry: false,
      kind: 'stream_truncation',
    });
    expect((errFields.err as Record<string, unknown>).message).toBe(STREAM_INCOMPLETE_MESSAGE);
  });

  it('does NOT log for a non-retryable error', () => {
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 3 });

    expect(s.isRetryable(new MaxTokensError('ceiling'))).toBe(false);

    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});
