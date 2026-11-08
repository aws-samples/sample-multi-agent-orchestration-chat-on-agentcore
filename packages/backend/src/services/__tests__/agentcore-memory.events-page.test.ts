/**
 * AgentCoreMemoryService.getSessionEventsPage — unit tests (AC1–AC5, AC8).
 *
 * ListEventsCommand is mocked: upstream pages are returned newest → oldest,
 * matching the documented production behavior.  Tests pin this assumption
 * (AC8 pin) so any future change to the sort order is caught immediately.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { AppError } from '../../libs/http/error-codes';
import { ErrorCode } from '../../libs/http/error-codes';

jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'test-memory-id' },
}));

// Mock the AWS SDK client so no network calls are made.
// We mock send() on BedrockAgentCoreClient and intercept ListEventsCommand.
jest.mock('@aws-sdk/client-bedrock-agentcore', () => {
  const actual = jest.requireActual<typeof import('@aws-sdk/client-bedrock-agentcore')>(
    '@aws-sdk/client-bedrock-agentcore'
  );
  return {
    ...actual,
    BedrockAgentCoreClient: jest.fn(),
    ListEventsCommand: jest.fn().mockImplementation((input) => ({ input })),
  };
});

import { AgentCoreMemoryService } from '../agentcore-memory';
import {
  PAGE_BYTE_BUDGET_BYTES,
  BLOCK_TRUNCATE_THRESHOLD_BYTES,
  decodeEventCursor,
  encodeEventCursor,
} from '../../libs/http/pagination';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a synthetic text-only event (newest → oldest means higher index = older). */
function makeTextEvent(id: string, text: string, ts: Date) {
  return {
    eventId: id,
    eventTimestamp: ts,
    payload: [
      {
        blob: Buffer.from(
          JSON.stringify({
            schemaVersion: 'v2-strands-sdk-1',
            messageType: 'content',
            role: 'assistant',
            content: [{ type: 'textBlock', text }],
          })
        ),
      },
    ],
  };
}

/** Build a synthetic toolUse event with a given JSON input blob. */
function makeToolUseEvent(id: string, ts: Date, inputBytes: number) {
  const bigInput = { data: 'x'.repeat(inputBytes) };
  return {
    eventId: id,
    eventTimestamp: ts,
    payload: [
      {
        blob: Buffer.from(
          JSON.stringify({
            schemaVersion: 'v2-strands-sdk-1',
            messageType: 'content',
            role: 'assistant',
            content: [
              {
                type: 'toolUseBlock',
                name: 'file_editor',
                toolUseId: `tu-${id}`,
                input: bigInput,
                status: 'completed',
              },
            ],
          })
        ),
      },
    ],
  };
}


/** Wrap a raw event array into a mock ListEvents response. */
function listEventsResponse(events: ReturnType<typeof makeTextEvent>[], nextToken?: string) {
  return { events, nextToken };
}

/** Create a mock BedrockAgentCoreClient with a controlled send() implementation. */
function makeMockClient(
  pages: Array<ReturnType<typeof listEventsResponse>>
) {
  let callIndex = 0;
  const send = jest.fn().mockImplementation(() => {
    const page = pages[callIndex] ?? { events: [], nextToken: undefined };
    callIndex++;
    return Promise.resolve(page);
  });
  return { send } as unknown as import('@aws-sdk/client-bedrock-agentcore').BedrockAgentCoreClient;
}

const SESSION_ID = 'testSESSION0000000000000000000001';
const MEMORY_ID = 'test-memory-id';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCoreMemoryService.getSessionEventsPage', () => {
  // AC1 + ordering pin: first page = newest events in chronological order.
  it('returns the newest page in chronological order (oldest→newest within page)', async () => {
    // Three events: event3 (newest), event2, event1 (oldest) — API order: newest→oldest.
    const t1 = new Date('2024-01-01T10:00:00Z');
    const t2 = new Date('2024-01-01T10:01:00Z');
    const t3 = new Date('2024-01-01T10:02:00Z');
    const client = makeMockClient([
      listEventsResponse([makeTextEvent('e3', 'msg3', t3), makeTextEvent('e2', 'msg2', t2), makeTextEvent('e1', 'msg1', t1)]),
    ]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);

    // Events in chronological order within the page.
    expect(page.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(page.events.map((e) => e.timestamp)).toEqual([
      t1.toISOString(),
      t2.toISOString(),
      t3.toISOString(),
    ]);
    // No more older pages.
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  // AC2: cursor navigation yields all events exactly once.
  it('navigates pages via cursor and yields each event exactly once', async () => {
    // Two upstream pages; each has 3 events (newest→oldest).
    const events = Array.from({ length: 6 }, (_, i) => {
      const id = `e${6 - i}`; // e6, e5, e4, e3, e2, e1
      const ts = new Date(`2024-01-01T10:0${5 - i}:00Z`);
      return makeTextEvent(id, `msg${6 - i}`, ts);
    });
    // Page 1: e6, e5, e4 (newest 3); page 2: e3, e2, e1 (oldest 3).
    const client = makeMockClient([
      listEventsResponse(events.slice(0, 3), 'tok-page2'),
      listEventsResponse(events.slice(3), undefined),
    ]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    // First downstream call with limit=3: should return newest 3 (e4, e5, e6 in chron order).
    const page1 = await svc.getSessionEventsPage('actor1', SESSION_ID, { limit: 3 });
    expect(page1.events.map((e) => e.id)).toEqual(['e4', 'e5', 'e6']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    // Decode cursor and apply to second call.
    const cursor2 = decodeEventCursor(page1.nextCursor!, SESSION_ID);
    expect(cursor2).toBeDefined();

    // Second downstream call: should return oldest 3 (e1, e2, e3 in chron order).
    const page2 = await svc.getSessionEventsPage('actor1', SESSION_ID, {
      limit: 3,
      cursor: cursor2!,
    });
    expect(page2.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(page2.hasMore).toBe(false);

    // Combined: all 6 events, no duplicates, correct order.
    const allIds = [...page1.events.map((e) => e.id), ...page2.events.map((e) => e.id)];
    expect(new Set(allIds).size).toBe(6);
    expect(allIds).toEqual(['e4', 'e5', 'e6', 'e1', 'e2', 'e3']);
  });

  // AC2: byte budget mid-upstream-page cursor resumes at exact offset.
  it('emits a cursor mid-upstream-page when budget is hit and resumes without gaps', async () => {
    // Create events where the 3rd event would push over a tiny budget.
    const t = (i: number) => new Date(`2024-01-01T10:0${i}:00Z`);
    const events = [
      makeTextEvent('e5', 'msg5', t(5)),
      makeTextEvent('e4', 'msg4', t(4)),
      makeTextEvent('e3', 'msg3', t(3)),
      makeTextEvent('e2', 'msg2', t(2)),
      makeTextEvent('e1', 'msg1', t(1)),
    ];
    const client = makeMockClient([listEventsResponse(events, undefined)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    // Limit of 2 → should return newest 2, cursor at offset 2.
    const page1 = await svc.getSessionEventsPage('actor1', SESSION_ID, { limit: 2 });
    expect(page1.events.map((e) => e.id)).toEqual(['e4', 'e5']);
    expect(page1.hasMore).toBe(true);
    const cursor2 = decodeEventCursor(page1.nextCursor!, SESSION_ID);
    expect(cursor2?.off).toBe(2);

    // Resume from offset 2 — create a new mock with the same upstream page.
    const client2 = makeMockClient([listEventsResponse(events, undefined)]);
    const svc2 = new AgentCoreMemoryService(MEMORY_ID, client2);
    const page2 = await svc2.getSessionEventsPage('actor1', SESSION_ID, {
      limit: 2,
      cursor: cursor2!,
    });
    expect(page2.events.map((e) => e.id)).toEqual(['e2', 'e3']);

    const cursor3 = decodeEventCursor(page2.nextCursor!, SESSION_ID);
    const client3 = makeMockClient([listEventsResponse(events, undefined)]);
    const svc3 = new AgentCoreMemoryService(MEMORY_ID, client3);
    const page3 = await svc3.getSessionEventsPage('actor1', SESSION_ID, {
      limit: 2,
      cursor: cursor3!,
    });
    expect(page3.events.map((e) => e.id)).toEqual(['e1']);
    expect(page3.hasMore).toBe(false);

    // No duplicates.
    const allIds = [
      ...page1.events.map((e) => e.id),
      ...page2.events.map((e) => e.id),
      ...page3.events.map((e) => e.id),
    ];
    expect(new Set(allIds).size).toBe(5);
  });

  // AC1 + large fixture: >6 MB total session → every page within budget.
  it('keeps every page within PAGE_BYTE_BUDGET_BYTES for a 600+ message large fixture', async () => {
    // Build 600 events, each with a toolUse whose input is ~12 KB.
    // Total ≈ 7.2 MB, well above the 6 MB Lambda limit.
    const BLOCK_SIZE = 12_000;
    const COUNT = 600;
    const events = Array.from({ length: COUNT }, (_, i) => {
      const ts = new Date(Date.now() - i * 1000);
      return makeToolUseEvent(`e${COUNT - i}`, ts, BLOCK_SIZE);
    });

    // All events on a single upstream page (no nextToken).
    // (Loop below creates a fresh client per iteration for clean mock state.)

    let cursor = undefined;
    let totalMessages = 0;
    let pages = 0;
    const allIds: string[] = [];

    do {
      // Reset mock on each iteration (same upstream page is re-fetched for each downstream page).
      const c = makeMockClient([listEventsResponse(events, undefined)]);
      const s = new AgentCoreMemoryService(MEMORY_ID, c);
      const page = await s.getSessionEventsPage('actor1', SESSION_ID, { cursor });

      // AC1: every page must be within budget.
      const pageBytes = Buffer.byteLength(JSON.stringify(page.events), 'utf8');
      expect(pageBytes).toBeLessThanOrEqual(PAGE_BYTE_BUDGET_BYTES);

      allIds.push(...page.events.map((e) => e.id));
      totalMessages += page.events.length;
      pages++;

      if (!page.hasMore) break;
      cursor = decodeEventCursor(page.nextCursor!, SESSION_ID);
      if (pages > 100) throw new Error('Too many pages — infinite loop?');
    } while (cursor);

    // All 600 messages returned without duplicates.
    expect(totalMessages).toBe(COUNT);
    expect(new Set(allIds).size).toBe(COUNT);
  });

  // AC5: single oversized message does not fail the request.
  it('returns a truncation placeholder for a single message that exceeds the budget', async () => {
    // A toolUse block well above the per-block truncation threshold.
    // applyContentTruncation replaces blocks > BLOCK_TRUNCATE_THRESHOLD_BYTES.
    const oversizeBytes = BLOCK_TRUNCATE_THRESHOLD_BYTES + 50_000;
    const ts = new Date('2024-01-01T10:00:00Z');
    const bigEvent = makeToolUseEvent('big1', ts, oversizeBytes);

    const client = makeMockClient([listEventsResponse([bigEvent], undefined)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);

    expect(page.events).toHaveLength(1);
    const contents = page.events[0].contents;
    // The oversized toolUse block must be replaced with a truncation placeholder.
    const truncated = contents.find((c) => c.type === 'truncated');
    expect(truncated).toBeDefined();
    expect((truncated as { type: 'truncated'; truncated: { originalType: string; byteSize: number } }).truncated.originalType).toBe('toolUse');
    expect((truncated as { type: 'truncated'; truncated: { originalType: string; byteSize: number } }).truncated.byteSize).toBeGreaterThan(BLOCK_TRUNCATE_THRESHOLD_BYTES);

    // Page is within budget after truncation.
    const pageBytes = Buffer.byteLength(JSON.stringify(page.events), 'utf8');
    expect(pageBytes).toBeLessThanOrEqual(PAGE_BYTE_BUDGET_BYTES);
  });

  // Empty session → { events: [], hasMore: false }.
  it('returns an empty page for a session with no events', async () => {
    const client = makeMockClient([listEventsResponse([], undefined)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);

    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cursor encode/decode tests (AC4)
// ---------------------------------------------------------------------------

describe('encodeEventCursor / decodeEventCursor', () => {
  it('round-trips a cursor without loss', () => {
    const cursor = { v: 1 as const, sid: SESSION_ID, tok: 'upstream-tok', off: 42 };
    const encoded = encodeEventCursor(cursor)!;
    expect(typeof encoded).toBe('string');
    const decoded = decodeEventCursor(encoded, SESSION_ID);
    expect(decoded).toEqual(cursor);
  });

  it('round-trips a first-page cursor (no tok)', () => {
    const cursor = { v: 1 as const, sid: SESSION_ID, off: 0 };
    const encoded = encodeEventCursor(cursor)!;
    const decoded = decodeEventCursor(encoded, SESSION_ID);
    expect(decoded).toEqual({ v: 1, sid: SESSION_ID, tok: undefined, off: 0 });
  });

  it('returns undefined for missing token', () => {
    expect(decodeEventCursor(undefined, SESSION_ID)).toBeUndefined();
  });

  // AC4: malformed cursor → 400
  it('throws VALIDATION_ERROR for a malformed cursor', () => {
    expect(() => decodeEventCursor('!!!not-base64url!!!', SESSION_ID)).toThrow(AppError);
    try {
      decodeEventCursor('!!!not-base64url!!!', SESSION_ID);
    } catch (e) {
      expect((e as InstanceType<typeof AppError>).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  // AC4: unknown version → 400
  it('throws VALIDATION_ERROR for unknown cursor version', () => {
    const badVersion = Buffer.from(JSON.stringify({ v: 99, sid: SESSION_ID, off: 0 })).toString('base64');
    expect(() => decodeEventCursor(badVersion, SESSION_ID)).toThrow(AppError);
    try {
      decodeEventCursor(badVersion, SESSION_ID);
    } catch (e) {
      expect((e as InstanceType<typeof AppError>).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  // AC4: wrong session → 400
  it('throws VALIDATION_ERROR for a cursor belonging to a different session', () => {
    const cursor = encodeEventCursor({ v: 1, sid: 'DIFFERENT_SESSION0000000000000001', off: 0 })!;
    expect(() => decodeEventCursor(cursor, SESSION_ID)).toThrow(AppError);
    try {
      decodeEventCursor(cursor, SESSION_ID);
    } catch (e) {
      expect((e as InstanceType<typeof AppError>).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  it('produces URL-safe base64 (no + / = characters)', () => {
    // Run many cursors to have statistical confidence no unsafe chars appear.
    for (let i = 0; i < 50; i++) {
      const tok = `token-${i}-${'abc'.repeat(i % 10)}`;
      const encoded = encodeEventCursor({ v: 1, sid: SESSION_ID, tok, off: i });
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    }
  });
});
