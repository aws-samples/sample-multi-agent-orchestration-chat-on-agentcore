/**
 * AgentCoreMemoryService.getSessionEventsPage — unit tests
 *
 * All AWS SDK calls are mocked so no real AWS resources are touched.
 *
 * Scenarios covered:
 *  1. Normal single-page response (no continuation)
 *  2. Response with nextToken (cursor generation + format)
 *  3. Cursor decode: valid cursor advances upstream token
 *  4. Cursor decode: malformed base64 → 400 VALIDATION_ERROR
 *  5. Cursor decode: cursor for wrong session → 400 VALIDATION_ERROR
 *  6. Byte budget: 622 events ~13 MB synthetic fixture stops well under budget
 *  7. Single-event overflow → 413 PAYLOAD_TOO_LARGE (explicit error)
 *  8. Empty session → empty page, no cursor
 *  9. Conversational payload (text-only events) are decoded correctly
 * 10. Multiple payload items within one event share the same eventId (no split)
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

/** Build a conversational payload text string of approximately `targetBytes` bytes. */
function bigText(targetBytes: number): string {
  return 'x'.repeat(targetBytes);
}

/** Encode an opaque cursor for a given sessionId + upstream token. */
function encodeCursor(sessionId: string, nextToken: string): string {
  return Buffer.from(JSON.stringify({ sessionId, nextToken }), 'utf-8').toString('base64url');
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

  // 1. Normal single page (no continuation)
  it('returns events and no cursor when upstream has no nextToken', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        { eventId: 'e1', timestamp: new Date('2024-01-01T00:00:00Z') },
        { eventId: 'e2', timestamp: new Date('2024-01-01T00:01:00Z') },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.truncated).toBe(false);
  });

  // 2. Response with nextToken → cursor is generated
  it('produces a nextCursor when upstream returns a nextToken', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([{ eventId: 'e1', timestamp: new Date() }], 'upstream-token-xyz')
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.hasMore).toBe(true);
    expect(typeof page.nextCursor).toBe('string');
    // Decode and verify structure
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf-8'));
    expect(decoded.sessionId).toBe(SESSION_ID);
    expect(decoded.nextToken).toBe('upstream-token-xyz');
  });

  // 3. Valid cursor passes upstream token through
  it('forwards the upstream nextToken when a valid cursor is supplied', async () => {
    const cursor = encodeCursor(SESSION_ID, 'upstream-page-2');
    const sendMock = jest.fn().mockResolvedValue(makeListEventsResponse([]));
    const client = makeMockClient(sendMock as Parameters<typeof makeMockClient>[0]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor);

    // The command sent to the AWS client should carry the decoded nextToken
    const sentCommand = (sendMock as jest.MockedFunction<typeof sendMock>).mock
      .calls[0][0] as Record<string, unknown>;
    expect((sentCommand as { input?: { nextToken?: string } }).input?.nextToken).toBe(
      'upstream-page-2'
    );
  });

  // 4. Malformed cursor → 400
  it('throws VALIDATION_ERROR for a malformed cursor (not valid base64url JSON)', async () => {
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, '!not-valid-base64url!!!')
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  // 5. Cursor for wrong session → 400
  it('throws VALIDATION_ERROR when cursor sessionId does not match route sessionId', async () => {
    const cursor = encodeCursor('other-session', 'tok');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, cursor)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  // 6. Byte budget: 622 events (~13 MB synthetic fixture) stops under budget
  it('stops well under SESSION_EVENTS_BYTE_BUDGET for a 622-event ~13 MB fixture', async () => {
    // Each event has a ~21 KB text payload → 622 × 21 KB ≈ 13 MB
    const payloadPerEvent = bigText(21 * 1024);
    const events = Array.from({ length: 622 }, (_, i) => ({
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

    const client = makeMockClient(() => makeListEventsResponse(events));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 100);

    // The serialised response must be under the byte budget
    const serialisedBytes = Buffer.byteLength(JSON.stringify(page.messages), 'utf-8');
    expect(serialisedBytes).toBeLessThan(SESSION_EVENTS_BYTE_BUDGET);

    // At least some messages should have been returned
    expect(page.messages.length).toBeGreaterThan(0);
    // Less than all 622 events (budget was hit before exhausting all events)
    expect(page.messages.length).toBeLessThan(622);
  });

  // 7. Single-event overflow → 413
  it('throws PAYLOAD_TOO_LARGE when the first event alone exceeds the byte budget', async () => {
    const oversizedText = bigText(SESSION_EVENTS_BYTE_BUDGET + 1);
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'huge',
          timestamp: new Date(),
          payloads: [
            {
              conversational: { role: 'USER', content: { text: oversizedText } },
            },
          ],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await expect(svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
    });
  });

  // 8. Empty session → empty page, no cursor
  it('returns an empty page with no cursor for a session with no events', async () => {
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  // 9. Conversational payload decoding
  it('decodes a conversational USER payload into a user message', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'conv-1',
          timestamp: new Date('2024-06-01T12:00:00Z'),
          payloads: [
            {
              conversational: {
                role: 'USER',
                content: { text: 'Hello world' },
              },
            },
          ],
        },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].type).toBe('user');
    expect(page.messages[0].contents[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(page.messages[0].timestamp).toBe('2024-06-01T12:00:00.000Z');
  });

  // 10. Multiple payload items within one event share the eventId
  it('emits multiple messages for an event with multiple payloads, all sharing the eventId', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        {
          eventId: 'multi-payload',
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
    expect(page.messages[0].id).toBe('multi-payload');
    expect(page.messages[1].id).toBe('multi-payload');
    expect(page.messages[0].type).toBe('user');
    expect(page.messages[1].type).toBe('assistant');
  });

  // 11. AppError is not re-wrapped (thrown as-is)
  it('re-throws an AppError directly without additional wrapping', async () => {
    const badCursor = Buffer.from(
      JSON.stringify({ sessionId: 'wrong', nextToken: 'x' }),
      'utf-8'
    ).toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    let caught: unknown;
    try {
      await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, badCursor);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
  });

  // 12. Cursor with null/array JSON body → 400
  it('throws VALIDATION_ERROR when cursor decodes to a non-object (e.g. null)', async () => {
    const nullCursor = Buffer.from('null', 'utf-8').toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, nullCursor)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  // 13. Cursor with array body → 400
  it('throws VALIDATION_ERROR when cursor decodes to an array', async () => {
    const arrayCursor = Buffer.from('[]', 'utf-8').toString('base64url');
    const client = makeMockClient(() => makeListEventsResponse([]));
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    await expect(
      svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50, arrayCursor)
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  // 14. Order preservation: messages appear in upstream event order
  it('returns messages in the same order as upstream events', async () => {
    const client = makeMockClient(() =>
      makeListEventsResponse([
        { eventId: 'first', timestamp: new Date('2024-01-01T00:00:00Z') },
        { eventId: 'second', timestamp: new Date('2024-01-01T00:01:00Z') },
        { eventId: 'third', timestamp: new Date('2024-01-01T00:02:00Z') },
      ])
    );
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);
    const page = await svc.getSessionEventsPage(ACTOR_ID, SESSION_ID, 50);

    expect(page.messages.map((m) => m.id)).toEqual(['first', 'second', 'third']);
  });
});
