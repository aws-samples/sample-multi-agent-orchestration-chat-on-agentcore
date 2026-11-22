/**
 * The usage client must read the freshest tokens per call (long turns keep
 * metering after renewTokens) and tell 401/403 apart from outages.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let auth = 'Bearer first';
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCallerAuthorizationHeader: () => auth,
  getCallerIdToken: () => 'id-token',
  getCurrentContext: () => undefined,
}));

const {
  fetchSummary,
  getSummary,
  postRecords,
  clearSummaryCacheForTest,
  setCachedSummaryForTest,
  invalidateSummary,
} = await import('../usage-client.js');

const ctx = { userId: 'user-1' } as never;
const fetchMock = jest.fn<typeof fetch>();
const summary = {
  enabled: true,
  period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: 'r' },
  groups: [],
  models: [],
};

beforeEach(() => {
  clearSummaryCacheForTest();
  fetchMock.mockReset();
  global.fetch = fetchMock;
  auth = 'Bearer first';
});
afterEach(() => jest.useRealTimers());

const respond = (status: number, body: unknown = {}) =>
  fetchMock.mockResolvedValueOnce(
    new Response(status === 204 ? null : JSON.stringify(body), { status })
  );

describe('usage-client', () => {
  it('sends the freshest Authorization on every call, plus the target user', async () => {
    respond(204);
    await postRecords([], ctx);
    auth = 'Bearer renewed';
    respond(204);
    await postRecords([], ctx);
    const headers = fetchMock.mock.calls.map((c) => c[1]!.headers as Record<string, string>);
    expect(headers.map((h) => h.Authorization)).toEqual(['Bearer first', 'Bearer renewed']);
    expect(headers[0]['X-Target-User-Id']).toBe('user-1');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    respond(status);
    expect((await postRecords([], ctx)).kind).toBe(kind);
  });

  it('maps network errors to unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    expect((await fetchSummary(ctx)).kind).toBe('unavailable');
  });

  it('maps 429 to throttled', async () => {
    respond(429);
    expect((await postRecords([], ctx)).kind).toBe('throttled');
  });

  it('serves a fresh cache entry without a request', async () => {
    respond(200, summary);
    expect(await getSummary(ctx)).toMatchObject({ kind: 'ok', value: summary });
    expect(await getSummary(ctx)).toMatchObject({ kind: 'ok', value: summary });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression: a stale entry used to be returned (and re-stamped as fresh),
  // so a turn could be decided on data predating the last turn or the month.
  it('never decides on a stale entry when the Backend answers', async () => {
    const old = {
      ...summary,
      models: [
        {
          modelKey: 'm',
          input: { used: 999, limit: 1 },
          output: { used: 0, limit: 1 },
          status: 'exceeded',
        },
      ],
    };
    setCachedSummaryForTest('user-1', old as never, Date.now() - 61_000);
    respond(200, summary);
    expect(await getSummary(ctx)).toMatchObject({ kind: 'ok', value: summary });
  });

  it('falls back to a stale same-month entry only when the Backend is down', async () => {
    const future = {
      ...summary,
      period: { ...summary.period, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    setCachedSummaryForTest('user-1', future as never, Date.now() - 61_000);
    respond(503);
    expect(await getSummary(ctx)).toMatchObject({ kind: 'ok', value: future });
  });

  it("does not fall back to last month's entry", async () => {
    const past = {
      ...summary,
      period: { ...summary.period, resetsAt: new Date(Date.now() - 1000).toISOString() },
    };
    setCachedSummaryForTest('user-1', past as never, Date.now() - 61_000);
    respond(503);
    expect((await getSummary(ctx)).kind).toBe('unavailable');
  });

  it('invalidateSummary forces the next read to the Backend', async () => {
    respond(200, summary);
    await getSummary(ctx);
    invalidateSummary('user-1');
    respond(200, summary);
    await getSummary(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
