import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const postRecords =
  jest.fn<(r: unknown[], ctx?: unknown, batchId?: string) => Promise<{ kind: string }>>();
const invalidateSummary = jest.fn();
jest.unstable_mockModule('../usage-client.js', () => ({ postRecords, invalidateSummary }));
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger,
  createLogger: () => logger,
}));

const {
  UsageRecorder,
  BATCH_SIZE,
  THROTTLE_RETRY_MS,
  drainUsage,
  unacknowledgedFor,
  resetUsageRecordersForTest,
  acknowledgedSnapshot,
  missingFromSummary,
} = await import('../usage-recorder.js');
const { isBusy, resetInFlight } = await import('../../../libs/health/in-flight.js');

const usage = { inputTokens: 10, outputTokens: 2 };

beforeEach(() => {
  postRecords.mockReset();
  resetUsageRecordersForTest();
  logger.error.mockClear();
  resetInFlight();
});

describe('UsageRecorder', () => {
  it('batches records and sends on flush, staying busy until sent', async () => {
    let release!: () => void;
    postRecords.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ kind: 'ok' })))
    );
    const rec = new UsageRecorder(undefined);
    rec.record('global.anthropic.claude-sonnet-4-6', usage);
    rec.record('global.anthropic.claude-sonnet-4-6', usage);
    const done = rec.flush();
    await Promise.resolve();
    expect(isBusy()).toBe(true);
    release();
    await done;
    expect(isBusy()).toBe(false);
    expect(postRecords).toHaveBeenCalledTimes(1);
    expect(postRecords.mock.calls[0][0]).toHaveLength(2);
  });

  it('sends as soon as BATCH_SIZE records are queued', async () => {
    postRecords.mockResolvedValue({ kind: 'ok' });
    const rec = new UsageRecorder(undefined);
    for (let i = 0; i < BATCH_SIZE; i++) rec.record('m.x', usage);
    await rec.flush();
    expect(postRecords).toHaveBeenCalledTimes(1);
  });

  it('skips empty usage', async () => {
    const rec = new UsageRecorder(undefined);
    rec.record('m.x', {});
    await rec.flush();
    expect(postRecords).not.toHaveBeenCalled();
  });

  it('reports 401/403 to the caller and logs the dropped records', async () => {
    postRecords.mockResolvedValue({ kind: 'unauthorized' });
    const onUnauthorized = jest.fn();
    const rec = new UsageRecorder(undefined, onUnauthorized);
    rec.record('m.x', usage);
    await rec.flush();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(postRecords).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unauthorized' }),
      'usage_record_dropped'
    );
  });

  it('retries outages, then drops with a structured log', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    postRecords.mockResolvedValue({ kind: 'unavailable' });
    const rec = new UsageRecorder(undefined);
    rec.record('m.x', usage);
    const done = rec.flush();
    await jest.runAllTimersAsync();
    await done;
    jest.useRealTimers();
    expect(postRecords).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unavailable' }),
      'usage_record_dropped'
    );
  });

  // Regression: 429 used to be retried twice then dropped, so heavy parallel
  // users escaped metering.
  it('re-queues a throttled batch and sends it later', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    postRecords.mockResolvedValueOnce({ kind: 'throttled' }).mockResolvedValue({ kind: 'ok' });
    const rec = new UsageRecorder({ userId: 'u-throttle' } as never);
    rec.record('m.x', usage);
    await rec.flush();
    expect(postRecords).toHaveBeenCalledTimes(1);
    expect(unacknowledgedFor('u-throttle', 'm.x')).toEqual({ input: 10, output: 2 });
    await jest.advanceTimersByTimeAsync(THROTTLE_RETRY_MS);
    await rec.flush();
    jest.useRealTimers();
    expect(postRecords).toHaveBeenCalledTimes(2);
    expect(postRecords.mock.calls[1][0]).toHaveLength(1);
    expect(unacknowledgedFor('u-throttle', 'm.x')).toEqual({ input: 0, output: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('tracks unacknowledged usage per user across recorders until the Backend accepts it', async () => {
    let release!: () => void;
    postRecords.mockImplementation(() => new Promise((r) => (release = () => r({ kind: 'ok' }))));
    const parent = new UsageRecorder({ userId: 'u-pend' } as never);
    const subAgent = new UsageRecorder({ userId: 'u-pend' } as never);
    parent.record('global.anthropic.claude-sonnet-4-6', { inputTokens: 100, outputTokens: 10 });
    subAgent.record('global.anthropic.claude-sonnet-4-6', {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadInputTokens: 50,
    });
    expect(unacknowledgedFor('u-pend', 'anthropic.claude-sonnet-4-6')).toEqual({
      input: 155,
      output: 11,
    });
    const done = parent.flush();
    await Promise.resolve();
    release();
    await done;
    expect(unacknowledgedFor('u-pend', 'anthropic.claude-sonnet-4-6')).toEqual({
      input: 55,
      output: 1,
    });
    expect(unacknowledgedFor('someone-else', 'anthropic.claude-sonnet-4-6')).toEqual({
      input: 0,
      output: 0,
    });
  });

  it('invalidates the cached summary whenever usage is recorded', () => {
    new UsageRecorder({ userId: 'u-inv' } as never).record('m.x', usage);
    expect(invalidateSummary).toHaveBeenCalledWith('u-inv');
  });

  it('drainUsage waits for sends in flight (bounded)', async () => {
    let release!: () => void;
    postRecords.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ kind: 'ok' })))
    );
    const rec = new UsageRecorder(undefined);
    rec.record('m.x', usage);
    void rec.flush();
    let drained = false;
    const d = drainUsage().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await d;
    expect(drained).toBe(true);
    // Bounded: a hung send does not block forever.
    postRecords.mockImplementationOnce(() => new Promise(() => {}));
    rec.record('m.x', usage);
    void rec.flush();
    const started = Date.now();
    await drainUsage(50);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // Regression: pending usage was per user, so another model's pending tokens
  // counted against this model's limit.
  it('keeps unacknowledged usage apart per model', () => {
    postRecords.mockImplementation(() => new Promise(() => {}));
    const rec = new UsageRecorder({ userId: 'u-model' } as never);
    rec.record('global.anthropic.claude-opus-5-5', { inputTokens: 400_000, outputTokens: 0 });
    rec.record('jp.anthropic.claude-haiku-5-5', { inputTokens: 10, outputTokens: 1 });
    expect(unacknowledgedFor('u-model', 'anthropic.claude-sonnet-4-6')).toEqual({
      input: 0,
      output: 0,
    });
    expect(unacknowledgedFor('u-model', 'anthropic.claude-opus-5-5').input).toBe(400_000);
    // cross-region profiles share one key
    expect(unacknowledgedFor('u-model', 'anthropic.claude-haiku-5-5')).toEqual({
      input: 10,
      output: 1,
    });
  });

  // Regression: a retry after an ambiguous failure must reuse the batch id
  // so the Backend can drop the duplicate.
  it('reuses the batch id on every retry of the same records', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    postRecords.mockResolvedValueOnce({ kind: 'unavailable' }).mockResolvedValue({ kind: 'ok' });
    const rec = new UsageRecorder(undefined);
    rec.record('m.x', usage);
    const done = rec.flush();
    await jest.runAllTimersAsync();
    await done;
    jest.useRealTimers();
    const ids = postRecords.mock.calls.map((c) => c[2]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Regression: drainUsage ignored records re-queued after a 429.
  it('drainUsage sends records still queued after a 429', async () => {
    postRecords.mockResolvedValueOnce({ kind: 'throttled' }).mockResolvedValue({ kind: 'ok' });
    const rec = new UsageRecorder({ userId: 'u-drain' } as never);
    rec.record('m.x', usage);
    await rec.flush(); // throttled → re-queued behind a 10 s timer
    expect(postRecords).toHaveBeenCalledTimes(1);
    await drainUsage();
    expect(postRecords).toHaveBeenCalledTimes(2);
    expect(unacknowledgedFor('u-drain', 'm.x')).toEqual({ input: 0, output: 0 });
  });

  // Regression: a summary fetched while a batch was acknowledged could miss
  // that batch after it had already left `pending`.
  it('reports usage acknowledged during a fetch as possibly missing from it', async () => {
    let release!: () => void;
    postRecords.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ kind: 'ok' })))
    );
    const rec = new UsageRecorder({ userId: 'u-race' } as never);
    rec.record('m.x', { inputTokens: 100, outputTokens: 10 });
    const sent = rec.flush();
    await Promise.resolve();
    const snapshot = acknowledgedSnapshot('u-race', 'm.x'); // fetch starts
    expect(missingFromSummary('u-race', 'm.x', snapshot)).toEqual({ input: 100, output: 10 });
    release();
    await sent; // acknowledged while the fetch is "in flight"
    expect(unacknowledgedFor('u-race', 'm.x')).toEqual({ input: 0, output: 0 });
    expect(missingFromSummary('u-race', 'm.x', snapshot)).toEqual({ input: 100, output: 10 });
    // A fetch started after the acknowledgement misses nothing.
    expect(missingFromSummary('u-race', 'm.x', acknowledgedSnapshot('u-race', 'm.x'))).toEqual({
      input: 0,
      output: 0,
    });
    expect(invalidateSummary).toHaveBeenCalledWith('u-race'); // on record and on ack
    expect(
      invalidateSummary.mock.calls.filter((c) => c[0] === 'u-race').length
    ).toBeGreaterThanOrEqual(2);
  });
});
