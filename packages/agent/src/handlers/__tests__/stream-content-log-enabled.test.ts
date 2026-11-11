/**
 * Stream content logging tests — LOG_CONTENT_ENABLED = true
 *
 * Verifies that when LOG_CONTENT_ENABLED is true:
 *   - Text block content is logged via pino after block stop
 *   - Reasoning block content is logged via pino after block stop
 *   - Tool use start (name only) is logged immediately
 *   - Tool input deltas are NOT logged (potential secrets)
 *   - Buffers are reset between blocks
 *   - Multiple blocks in one stream each produce separate log entries
 *
 * Uses jest.unstable_mockModule to override mask-secrets so that
 * LOG_CONTENT_ENABLED is true for this test file only.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Shared mock infrastructure ──────────────────────────────────────

const mockLoggerInfo = jest.fn<any>();
const mockGetCurrentContext = jest.fn<any>();
const mockGetContextMetadata = jest.fn<any>();
const mockSerializeStreamEvent = jest.fn<any>().mockImplementation((e: any) => [e]);
const mockBuildInputContent = jest.fn<any>().mockImplementation((p: string) => p);

// ── ESM mock registrations (before all imports) ─────────────────────

jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
  getContextMetadata: mockGetContextMetadata,
}));

jest.unstable_mockModule('../../libs/utils/index.js', () => ({
  createErrorMessage: jest.fn().mockReturnValue({ role: 'assistant', content: [] }),
  sanitizeErrorMessage: jest.fn().mockReturnValue('error'),
  serializeStreamEvent: mockSerializeStreamEvent,
  buildInputContent: mockBuildInputContent,
}));

// Override mask-secrets: LOG_CONTENT_ENABLED = true
jest.unstable_mockModule('../../libs/logger/mask-secrets.js', () => ({
  LOG_CONTENT_ENABLED: true,
  maskSecrets: (t: string) => t,
  summarizeContent: (text: string, label: string) => ({
    [label]: text,
    [`${label}Chars`]: text.length,
  }),
}));

// ── Dynamic import (after mocks) ────────────────────────────────────

const { streamAgentResponse } = await import('../stream-handler.js');

// ── Helpers ─────────────────────────────────────────────────────────

function makeAgent(events: unknown[]) {
  return {
    messages: [],
    stream: jest.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev;
      },
    }),
  } as any;
}

const makeRes = () =>
  ({ setHeader: jest.fn(), write: jest.fn(), end: jest.fn() }) as any;

const opts = {
  metadata: { loadedMessagesCount: 0, longTermMemoriesCount: 0, toolsCount: 1 },
};

// ── Tests ────────────────────────────────────────────────────────────

describe('processEventForContentLog (LOG_CONTENT_ENABLED=true)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentContext.mockReturnValue({ requestId: 'req-1' });
    mockGetContextMetadata.mockReturnValue({ duration: 10 });
    mockSerializeStreamEvent.mockImplementation((e: any) => [e]);
    mockBuildInputContent.mockImplementation((p: string) => p);
  });

  it('logs a text block on block stop', async () => {
    const events = [
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello ' } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'world' } },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const textCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream text block:'
    );
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0][0]).toMatchObject({ streamText: 'Hello world' });
  });

  it('logs a reasoning block on block stop', async () => {
    const events = [
      {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'think hard' },
      },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const reasoningCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream reasoning block:'
    );
    expect(reasoningCalls).toHaveLength(1);
    expect(reasoningCalls[0][0]).toMatchObject({ reasoning: 'think hard' });
  });

  it('logs tool use started with toolName', async () => {
    const events = [
      {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'execute_command' },
      },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const toolCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Tool use started:'
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0][0]).toMatchObject({ toolName: 'execute_command' });
  });

  it('does not emit a text log when no text deltas preceded the stop event', async () => {
    const events = [{ type: 'modelContentBlockStopEvent' }];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const textCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream text block:'
    );
    expect(textCalls).toHaveLength(0);
  });

  it('accumulates all text deltas before logging at stop', async () => {
    const events = [
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'A' } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'B' } },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'C' } },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const textCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream text block:'
    );
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0][0]).toMatchObject({ streamText: 'ABC', streamTextChars: 3 });
  });

  it('resets buffer between blocks, producing separate log entries', async () => {
    const events = [
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'first' } },
      { type: 'modelContentBlockStopEvent' },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'second' } },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const textCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream text block:'
    );
    expect(textCalls).toHaveLength(2);
    expect(textCalls[0][0]).toMatchObject({ streamText: 'first' });
    expect(textCalls[1][0]).toMatchObject({ streamText: 'second' });
  });

  it('does not log tool input deltas (potential secrets)', async () => {
    const events = [
      {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', text: '--password=s3cr3t' },
      },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const contentCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) =>
        c[1] === 'Stream text block:' || c[1] === 'Stream reasoning block:'
    );
    expect(contentCalls).toHaveLength(0);
  });
});
