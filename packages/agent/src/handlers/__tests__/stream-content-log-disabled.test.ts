/**
 * Stream content logging tests — LOG_CONTENT_ENABLED = false (default)
 *
 * Verifies that when LOG_CONTENT_ENABLED is false (the production default):
 *   - No text block / reasoning / tool-use logger.info calls are made
 *   - Events are still serialised and written to the HTTP response as normal
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Shared mocks ────────────────────────────────────────────────────

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

// LOG_CONTENT_ENABLED = false (the production default)
jest.unstable_mockModule('../../libs/logger/mask-secrets.js', () => ({
  LOG_CONTENT_ENABLED: false,
  maskSecrets: (t: string) => t,
  summarizeContent: (_text: string, label: string) => ({ [`${label}Chars`]: _text?.length ?? 0 }),
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

describe('processEventForContentLog (LOG_CONTENT_ENABLED=false)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentContext.mockReturnValue({ requestId: 'req-1' });
    mockGetContextMetadata.mockReturnValue({ duration: 10 });
    mockSerializeStreamEvent.mockImplementation((e: any) => [e]);
    mockBuildInputContent.mockImplementation((p: string) => p);
  });

  it('does not log stream text blocks', async () => {
    const events = [
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'secret' } },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const contentCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream text block:'
    );
    expect(contentCalls).toHaveLength(0);
  });

  it('does not log reasoning blocks', async () => {
    const events = [
      {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'think' },
      },
      { type: 'modelContentBlockStopEvent' },
    ];
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, makeRes(), opts);

    const reasoningCalls = mockLoggerInfo.mock.calls.filter(
      (c: any[]) => c[1] === 'Stream reasoning block:'
    );
    expect(reasoningCalls).toHaveLength(0);
  });

  it('does not log tool use started', async () => {
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
    expect(toolCalls).toHaveLength(0);
  });

  it('still serialises and writes events to the response', async () => {
    const events = [
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'hi' } },
      { type: 'modelContentBlockStopEvent' },
    ];
    const res = makeRes();
    await streamAgentResponse(makeAgent(events), 'prompt', undefined, res, opts);

    // 2 events + 1 completion event
    expect(res.write).toHaveBeenCalledTimes(3);
  });
});
