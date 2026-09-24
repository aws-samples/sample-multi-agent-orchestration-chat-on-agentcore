/**
 * AgentCoreMemoryService.getSessionEventsPage — unit tests
 *
 * All AWS SDK calls are mocked so no real AWS resources are touched.
 *
 * Key correctness properties verified:
 *  A. Normal single-page, next-page cursor, cursor forwarding, and pageSize handling
 *  B. Cursor v1 strict validation (format, version, sessionId, type checks,
 *     pageSize range, offset/pageSize cross-field, safe-integer, offset range)
 *  C. Byte budget: mid-page cut stores offset+pageSize in cursor so NO events
 *     are lost — full traversal asserts every event ID appears exactly once
 *     (both cases: upstream page WITH nextToken and WITHOUT nextToken);
 *     622-event fixture split across realistic ≤100-event upstream pages
 *  D. Single-event overflow → 413 (explicit error rather than empty page)
 *     including the empty-events-before-giant-event scenario
 *  E. Upstream 4xx (ValidationException, ResourceNotFoundException) → AppError
 *  F. Stable per-payload IDs: multi-payload event emits IDs `${eventId}:${i}`
 *  G. Events are sorted by timestamp within a page (regardless of API order)
 *  H. Edge cases (empty session, payload decoding, empty first page)
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'test-memory-id' },
}));

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreMemoryService, SESSION_EVENTS_BYTE_BUDGET } from '../agentcore-memory';
import { AppError, ErrorCode } from '../../libs/http/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake ListEventsCommand response. */
function makeListEventsResponse(
  events: Array<{
    eventId: string;
    timestamp: Date;
    payloads?: Array<Record<string, unknown>>;
  }>,
  nextToken?: string
) {
  return {
    events: events.map((e) => ({
      eventId: e.eventId,
      eventTimestamp: e.timestamp,
      payload: e.payloads ?? [
        {
          conversational: {
            role: 'USER',
            content: { text: `Hello from ${e.eventId}` },
          },
        },
      ],
    })),
    nextToken,
  };
}

/** Build a text string of approximately `targetBytes` bytes. */
function bigText(targetBytes: number): string {
  return 'x'.repeat(targetBytes);
}

/** Decode an opaque v1 cursor produced by getSessionEventsPage. */
function decodeCursor(cursor: string): {
  v: number;
  sessionId: string;
  pageToken?: string;
  offset?: number;
  pageSize?: number;
} {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
}

/** Encode a v1 cursor (for feeding back to the service). */
function encodeCursorV1(
  sessionId: string,
  opts: { pageToken?: string; offset?: number; pageSize?: number } = {}
): string {
  return Buffer.from(JSON.stringify({ v: 1, sessionId, ...opts }), 'utf-8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeMockClient(sendImpl: (cmd: unknown) => unknown): BedrockAgentCoreClient {
  return { send: jest.fn().mockImplementation(sendImpl) } as unknown as BedrockAgentCoreClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCoreMemoryService.getSessionEventsPage', () => {
  const MEMORY_ID = 'test-memory-id';
  const ACTOR_ID = 'actor-123';
  const SESSION_ID = 'session-abc';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── A. Basic pagination ───────────────────────────────────────────────────

  it('returns events and no cursor when upstream has no nextToken', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        { eventId: 'e1', timestamp: new Date('2024-01-01T00:00:00Z') },
        { eventId: 'e2', timestamp: new Date('2024-01-01T00:01:00Z') },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.messages.length).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.truncated).toBe(false);
  });

  it('produces a v1 nextCursor (with pageSize) when upstream returns a nextToken', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([{ eventId: 'e1', timestamp: new Date() }], 'upstream-tok')
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.hasMore).toBe(true);
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded.v).toBe(1);
    expect(decoded.sessionId).toBe(SESSION_ID);
    expect(decoded.pageToken).toBe('upstream-tok');
    expect(decoded.offset).toBeUndefined(); // clean next-page cursor has no offset
    expect(decoded.pageSize).toBe(50); // pageSize stored in cursor
  });

  it('forwards the upstream pageToken when a valid v1 cursor is supplied', async () => {
    const cursor = encodeCursorV1(SESSION_ID, { pageToken: 'upstream-page-2' });
    const sendMock = jest.fn().mockResolvedValue(makeListEventsResponse([]));
    const client = { send: sendMock } as unknown as BedrockAgentCoreClient;
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor);

    const sentInput = (sendMock.mock.calls[0][0] as { input?: { nextToken?: string } }).input;
    expect(sentInput?.nextToken).toBe('upstream-page-2');
  });

  it('uses cursor.pageSize for upstream maxResults, ignoring the caller limit', async () => {
    // Cursor was created with pageSize=100 (first call used limit=100).
    // Second call uses limit=1. The upstream fetch must use maxResults=100.
    const cursor = encodeCursorV1(SESSION_ID, { pageToken: 'page2', pageSize: 100 });
    const sendMock = jest.fn().mockResolvedValue(makeListEventsResponse([]));
    const client = { send: sendMock } as unknown as BedrockAgentCoreClient;
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 1 /* different limit */, cursor);

    const sentInput = (sendMock.mock.calls[0][0] as { input?: { maxResults?: number } }).input;
    expect(sentInput?.maxResults).toBe(100); // must use cursor.pageSize
  });

  it('falls back to caller limit when cursor has no pageSize (backward compat)', async () => {
    // Cursor without pageSize (created before this field was introduced).
    const cursor = encodeCursorV1(SESSION_ID, { pageToken: 'page2' }); // no pageSize
    const sendMock = jest.fn().mockResolvedValue(makeListEventsResponse([]));
    const client = { send: sendMock } as unknown as BedrockAgentCoreClient;
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 77 /* any limit */, cursor);

    const sentInput = (sendMock.mock.calls[0][0] as { input?: { maxResults?: number } }).input;
    expect(sentInput?.maxResults).toBe(77); // falls back to caller's limit
  });

  it('mid-page cursor includes pageSize; offset range check: offset ≥ rawEvents.length → 400', async () => {
    // Simulate: cursor says offset=5, but upstream now returns only 3 events
    // (e.g. events were deleted). Must throw VALIDATION_ERROR, not silently
    // succeed with an empty page.
    const cursor = encodeCursorV1(SESSION_ID, { offset: 5, pageSize: 10 });
    const client = makeMockClient(() =>
      makeListEventsResponse(
        Array.from({ length: 3 }, (_, i) => ({ eventId: `e${i}`, timestamp: new Date() }))
      )
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 10, cursor)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  // ── B. Cursor validation ──────────────────────────────────────────────────

  it('throws VALIDATION_ERROR for a malformed cursor (not valid base64url JSON)', async () => {
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, '!not-valid!!!')
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor sessionId does not match route sessionId', async () => {
    const cursor = encodeCursorV1('other-session', { pageToken: 'tok' });
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('throws VALIDATION_ERROR for cursor version other than 1', async () => {
    const badVersion = Buffer.from(
      JSON.stringify({ v: 2, sessionId: SESSION_ID }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, badVersion)
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('throws VALIDATION_ERROR when cursor decodes to null', async () => {
    const nullCursor = Buffer.from('null', 'utf-8').toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, nullCursor)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor decodes to an array', async () => {
    const arrayCursor = Buffer.from('[]', 'utf-8').toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, arrayCursor)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor.pageToken is a number (not a string)', async () => {
    const badPageToken = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, pageToken: 42 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, badPageToken)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor.offset is negative', async () => {
    const badOffset = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, offset: -1 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, badOffset)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor.offset is a non-integer float', async () => {
    const badOffset = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, offset: 1.5 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, badOffset)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor.offset is Number.MAX_SAFE_INTEGER + 1 (unsafe integer)', async () => {
    const unsafeOffset = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, offset: Number.MAX_SAFE_INTEGER + 1 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, unsafeOffset)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('throws VALIDATION_ERROR when cursor.pageSize is 0', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, pageSize: 0 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('throws VALIDATION_ERROR when cursor.pageSize exceeds SESSION_EVENTS_MAX_LIMIT', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, pageSize: 101 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('throws VALIDATION_ERROR when cursor.offset >= cursor.pageSize (cross-field check)', async () => {
    // offset=10, pageSize=10 → offset must be LESS THAN pageSize
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, offset: 10, pageSize: 10 }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  // ── C. Byte-budget: full-traversal / no events lost ───────────────────────

  /**
   * Helper: follow all cursors for a multi-call session until hasMore=false.
   * Returns the ordered list of message IDs collected across all pages.
   * Optionally, a `limitOverride` can differ from the first call's limit to
   * verify that cursor.pageSize governs the upstream maxResults (not the
   * caller's limit).
   */
  async function traverseAllPages(
    svc: AgentCoreMemoryService,
    sessionId: string,
    firstLimit: number,
    continuationLimit?: number
  ): Promise<string[]> {
    const allIds: string[] = [];
    let cursor: string | undefined;
    let iterations = 0;
    const MAX = 10000; // safety cap
    do {
      const limitToUse = cursor ? (continuationLimit ?? firstLimit) : firstLimit;
      const page = await svc.getSessionEventsPage(ACTOR_ID, sessionId, limitToUse, cursor);
      allIds.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
      iterations++;
      if (iterations > MAX) throw new Error('traverseAllPages: safety cap exceeded');
    } while (cursor !== undefined);
    return allIds;
  }

  it('P0: traversing all cursors yields every event ID exactly once — mid-page budget cut, NO upstream nextToken', async () => {
    // 6 events, each ~1.5 MiB text. Budget (4 MiB) allows ~2 events per page.
    // All 6 events are on a single upstream page (no nextToken).
    const eventText = bigText(1.5 * 1024 * 1024);
    const eventCount = 6;
    const events = Array.from({ length: eventCount }, (_, i) => ({
      eventId: `evt-${i}`,
      timestamp: new Date(1000000 + i * 1000),
      payloads: [{ conversational: { role: 'USER', content: { text: eventText } } }],
    }));

    // The mock always returns the same single page (no nextToken).
    const client = makeMockClient(() => makeListEventsResponse(events)); // no nextToken
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const allIds = await traverseAllPages(svc, SESSION_ID, 10);

    // Each event produces one message with ID `evt-N:0`.
    const expectedIds = events.map((e) => `${e.eventId}:0`);
    expect(allIds).toHaveLength(eventCount);
    expect(allIds.sort()).toEqual(expectedIds.sort());
  });

  it('P0: traversing all cursors yields every event ID exactly once — mid-page budget cut WITH upstream nextToken', async () => {
    // Page 1 (no input token): 4 large events, budget cuts after ~2.
    // Page 2 (nextToken="page2"): 3 smaller events.
    const bigText15 = bigText(1.5 * 1024 * 1024);
    const smallText = 'hello';

    const page1Events = Array.from({ length: 4 }, (_, i) => ({
      eventId: `p1-${i}`,
      timestamp: new Date(1000 + i * 1000),
      payloads: [{ conversational: { role: 'USER', content: { text: bigText15 } } }],
    }));
    const page2Events = Array.from({ length: 3 }, (_, i) => ({
      eventId: `p2-${i}`,
      timestamp: new Date(10000 + i * 1000),
      payloads: [{ conversational: { role: 'ASSISTANT', content: { text: smallText } } }],
    }));

    const sendMock = jest.fn().mockImplementation((cmd: { input?: { nextToken?: string } }) => {
      const token = cmd?.input?.nextToken;
      if (!token) return makeListEventsResponse(page1Events, 'page2');
      if (token === 'page2') return makeListEventsResponse(page2Events);
      throw new Error(`Unexpected token: ${token}`);
    });
    const client = { send: sendMock } as unknown as BedrockAgentCoreClient;
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const allIds = await traverseAllPages(svc, SESSION_ID, 10);

    const expectedIds = [
      ...page1Events.map((e) => `${e.eventId}:0`),
      ...page2Events.map((e) => `${e.eventId}:0`),
    ];
    expect(allIds).toHaveLength(7);
    expect(allIds.sort()).toEqual(expectedIds.sort());
  });

  it('P0A: first call limit=100, cursor continuation with limit=1 yields no events lost', async () => {
    // This test specifically verifies that cursor.pageSize governs the
    // upstream maxResults on resume, preventing the offset-out-of-range bug
    // that would occur if the caller's lower limit were used instead.
    //
    // Setup: 10 events ~700 KB each. Budget (4 MiB) allows ~5 per page.
    // First call: limit=100, budget cuts mid-page, cursor.pageSize=100.
    // Continuation calls: limit=1 (different!), but must use maxResults=100.
    const eventText = bigText(700 * 1024); // ~700 KB each
    const eventCount = 10;
    const events = Array.from({ length: eventCount }, (_, i) => ({
      eventId: `big-${i}`,
      timestamp: new Date(1000000 + i * 1000),
      payloads: [{ conversational: { role: 'USER', content: { text: eventText } } }],
    }));

    const sendMock = jest
      .fn()
      .mockImplementation((cmd: { input?: { maxResults?: number; nextToken?: string } }) => {
        const { maxResults = 50, nextToken } = cmd?.input ?? {};
        // Simulate upstream respecting maxResults: slice from offset 0.
        // (Real API returns ≤maxResults events. Here we return exactly maxResults
        // items from the front to simulate a realistic single upstream page.)
        const pageEvents = events.slice(0, maxResults);
        const hasMore = events.length > maxResults && !nextToken;
        return makeListEventsResponse(pageEvents, hasMore ? undefined : undefined);
      });
    const client = { send: sendMock } as unknown as BedrockAgentCoreClient;
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    // Full traversal: first limit=100, continuations limit=1.
    // cursor.pageSize=100 must be used for all continuation upstream calls.
    const allIds = await traverseAllPages(svc, SESSION_ID, 100, 1 /* continuation limit */);

    // Verify all events were recovered.
    expect(allIds).toHaveLength(eventCount);
    const expectedIds = events.map((e) => `${e.eventId}:0`).sort();
    expect(allIds.sort()).toEqual(expectedIds);

    // Verify that ALL upstream calls used maxResults=100 (cursor.pageSize),
    // not maxResults=1 (the caller's continuation limit).
    const allCalls = sendMock.mock.calls as Array<[{ input?: { maxResults?: number } }]>;
    for (const [call] of allCalls) {
      expect(call?.input?.maxResults).toBe(100);
    }
  });

  it('622-event fixture across realistic multi-page upstream (≤100 events/page): traversal yields all IDs', async () => {
    // Realistic upstream API: max 100 events per page.
    // 622 total events → 7 upstream pages (6×100 + 1×22).
    // Each event is ~21 KB → a single upstream page of 100 events is ~2.1 MB
    // (under the 4 MiB budget), so no mid-page budget cuts occur here.
    // This test validates multi-upstream-page traversal with realistic page sizes.
    const payloadPerEvent = bigText(21 * 1024); // ~21 KB
    const eventCount = 622;
    const UPSTREAM_PAGE_SIZE = 100;
    const allEvents = Array.from({ length: eventCount }, (_, i) => ({
      eventId: `evt-${i}`,
      timestamp: new Date(Date.now() + i * 1000),
      payloads: [
        {
          conversational: {
            role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
            content: { text: payloadPerEvent },
          },
        },
      ],
    }));

    // Build a map from nextToken → page of events.
    // Token for page N (0-indexed) = `page${N}` (or undefined for page 0).
    const sendMock = jest.fn().mockImplementation((cmd: { input?: { nextToken?: string } }) => {
      const token = cmd?.input?.nextToken;
      const pageIndex = token ? parseInt(token.replace('page', ''), 10) : 0;
      const start = pageIndex * UPSTREAM_PAGE_SIZE;
      const end = Math.min(start + UPSTREAM_PAGE_SIZE, eventCount);
      const isLastPage = end >= eventCount;
      const nextToken = isLastPage ? undefined : `page${pageIndex + 1}`;
      return makeListEventsResponse(allEvents.slice(start, end), nextToken);
    });
    const client = { send: sendMock } as unknown as BedrockAgentCoreClient;
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    // Full traversal must recover ALL event IDs exactly once.
    const allIds = await traverseAllPages(svc, SESSION_ID, 100);
    expect(allIds).toHaveLength(eventCount);
    const expectedIds = allEvents.map((e) => `${e.eventId}:0`).sort();
    expect(allIds.sort()).toEqual(expectedIds);

    // Every page should be within budget (no mid-page cuts in this case).
    // We verify this by checking that each page returned by the service
    // corresponds to one upstream call — no page re-fetches.
    // With 622 events and UPSTREAM_PAGE_SIZE=100: 7 upstream pages,
    // no budget cuts → exactly 7 upstream API calls.
    const pageCount = Math.ceil(eventCount / UPSTREAM_PAGE_SIZE); // 7
    expect(sendMock.mock.calls.length).toBe(pageCount);
  });

  // ── D. Single-event overflow ───────────────────────────────────────────────

  it('throws PAYLOAD_TOO_LARGE when the first event alone exceeds the byte budget', async () => {
    const oversizedText = bigText(SESSION_EVENTS_BYTE_BUDGET + 1);
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'huge',
          timestamp: new Date(),
          payloads: [{ conversational: { role: 'USER', content: { text: oversizedText } } }],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
    });
  });

  it('throws PAYLOAD_TOO_LARGE immediately when empty events precede a giant event (no cursor endless loop)', async () => {
    // Without the fix (messages.length===0 guard), the code would check
    // `messages.length === 0 && eventsConsumed === 0`. Because the empty
    // events increment eventsConsumed, the condition would be false, causing
    // a budget-break cursor to be emitted for an empty page — creating an
    // endless cycle where the giant event is never reachable.
    //
    // With the fix (`messages.length === 0` only), the giant event is
    // immediately identified as oversized and a 413 is thrown.
    const oversizedText = bigText(SESSION_EVENTS_BYTE_BUDGET + 1);
    const client = makeMockClient(() =>
      makeListEventsResponse([
        // Two empty-payload events come first.
        { eventId: 'empty-0', timestamp: new Date(1000), payloads: [] },
        { eventId: 'empty-1', timestamp: new Date(2000), payloads: [] },
        // Giant event follows.
        {
          eventId: 'giant',
          timestamp: new Date(3000),
          payloads: [{ conversational: { role: 'USER', content: { text: oversizedText } } }],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
    });
  });

  // ── E. Upstream error mapping ──────────────────────────────────────────────

  it('maps upstream ValidationException to VALIDATION_ERROR (400)', async () => {
    const err = Object.assign(new Error('bad param'), { name: 'ValidationException' });
    const client = makeMockClient(() => {
      throw err;
    });
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('maps upstream ResourceNotFoundException to NOT_FOUND (404)', async () => {
    const err = Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
    const client = makeMockClient(() => {
      throw err;
    });
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('re-throws an AppError directly without additional wrapping', async () => {
    const cursor = encodeCursorV1('wrong-session', { pageToken: 'x' });
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    let caught: unknown;
    try {
      await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
  });

  // ── F. Stable per-payload IDs ──────────────────────────────────────────────

  it('emits IDs as `${eventId}:${payloadIdx}` for multi-payload events', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'multi',
          timestamp: new Date(),
          payloads: [
            { conversational: { role: 'USER', content: { text: 'first' } } },
            { conversational: { role: 'ASSISTANT', content: { text: 'second' } } },
          ],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.messages).toHaveLength(2);
    expect(page.messages[0].id).toBe('multi:0');
    expect(page.messages[1].id).toBe('multi:1');
    expect(page.messages[0].type).toBe('user');
    expect(page.messages[1].type).toBe('assistant');
  });

  it('emits ID as `${eventId}:0` for single-payload events', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'single',
          timestamp: new Date('2024-06-01T12:00:00Z'),
          payloads: [{ conversational: { role: 'USER', content: { text: 'hello' } } }],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);
    expect(page.messages[0].id).toBe('single:0');
  });

  // ── G. Timestamp sort ─────────────────────────────────────────────────────

  it('returns messages sorted by timestamp regardless of upstream order', async () => {
    // Feed events in reverse timestamp order to the mock.
    const client = makeMockClient(() =>
      makeListEventsResponse([
        { eventId: 'third', timestamp: new Date('2024-01-01T00:02:00Z') },
        { eventId: 'first', timestamp: new Date('2024-01-01T00:00:00Z') },
        { eventId: 'second', timestamp: new Date('2024-01-01T00:01:00Z') },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    // Should be sorted oldest → newest regardless of input order.
    expect(page.messages.map((m) => m.id)).toEqual(['first:0', 'second:0', 'third:0']);
  });

  // ── H. Edge cases ─────────────────────────────────────────────────────────

  it('returns an empty page with no cursor for a session with no events', async () => {
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);
    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('decodes a conversational USER payload into a user message with correct timestamp', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'conv-1',
          timestamp: new Date('2024-06-01T12:00:00Z'),
          payloads: [{ conversational: { role: 'USER', content: { text: 'Hello world' } } }],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);
    expect(page.messages[0].type).toBe('user');
    expect(page.messages[0].contents[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(page.messages[0].timestamp).toBe('2024-06-01T12:00:00.000Z');
  });
});
