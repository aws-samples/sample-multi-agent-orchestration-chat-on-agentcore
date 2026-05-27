/**
 * Stream Handler Unit Tests
 *
 * Tests for streamAgentResponse() which manages the streaming lifecycle:
 * headers, event loop, completion, and error handling.
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mock definitions (must be before jest.unstable_mockModule) ──────

const mockGetCurrentContext = jest.fn<any>();
const mockGetContextMetadata = jest.fn<any>();
const mockCreateErrorMessage = jest
  .fn<any>()
  .mockReturnValue({ role: 'assistant', content: 'error' });
const mockSanitizeErrorMessage = jest.fn<any>().mockReturnValue('Sanitized error');
// `serializeStreamEvent` returns an array (one entry per emitted NDJSON line).
// SDK 1.x's `modelStreamUpdateEvent` is unwrapped into the inner legacy event,
// but most events round-trip 1:1, which the default mock implements.
const mockSerializeStreamEvent = jest.fn<any>().mockImplementation((event: any) => [event]);
const mockBuildInputContent = jest.fn<any>().mockImplementation((prompt: string) => prompt);

// Default behaviour: identity (no classification). Individual tests can call
// `mockClassifyStreamError.mockImplementationOnce(...)` to override.
const mockClassifyStreamError = jest.fn<any>().mockImplementation((e: unknown) => e);

// Logger mock — we need to be able to inspect what stream-handler logs so that
// we can assert observability properties (e.g. errors are logged under the
// `err` key so pino's stdSerializers.err captures message/stack/cause).
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();

// ── Register ESM mocks ─────────────────────────────────────────────

jest.unstable_mockModule('../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));

jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  },
}));

jest.unstable_mockModule('../../libs/utils/index.js', () => ({
  createErrorMessage: mockCreateErrorMessage,
  sanitizeErrorMessage: mockSanitizeErrorMessage,
  serializeStreamEvent: mockSerializeStreamEvent,
  buildInputContent: mockBuildInputContent,
  // classifyStreamError is identity by default; tests that need promotion
  // override this via mockClassifyStreamError.mockImplementationOnce(...).
  classifyStreamError: (e: unknown) => mockClassifyStreamError(e),
}));

jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
  getContextMetadata: mockGetContextMetadata,
}));

// ── Dynamic imports (after mock registration) ──────────────────────

const { streamAgentResponse } = await import('../stream-handler.js');
import type { StreamOptions } from '../stream-handler.js';
import type { IdentityId, SessionId } from '@moca/core';

/** Create a mock Express Response */
function createMockResponse() {
  const res: any = {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  return res;
}

/** Create a mock Agent with configurable stream behavior */
function createMockAgent(events: unknown[] = [{ type: 'text', data: 'Hello' }]) {
  return {
    messages: [{ role: 'user' }, { role: 'assistant' }],
    stream: jest.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    }),
  } as any;
}

/** Create a mock Agent that throws during streaming */
function createErrorAgent(error: Error) {
  return {
    messages: [],
    stream: jest.fn().mockReturnValue(
      (async function* () {
        throw error;
        yield; // unreachable, satisfies generator requirement
      })()
    ),
  } as any;
}

describe('streamAgentResponse', () => {
  let res: any;
  let defaultOptions: StreamOptions;

  beforeEach(() => {
    jest.clearAllMocks();
    res = createMockResponse();
    defaultOptions = {
      metadata: {
        loadedMessagesCount: 0,
        longTermMemoriesCount: 0,
        toolsCount: 3,
      },
    };

    // Set mock return values in beforeEach to avoid hoisting issues
    mockGetCurrentContext.mockReturnValue({
      requestId: 'test-request-id',
      userId: 'test-user',
      sessionId: 'test-session' as SessionId,
    });
    mockGetContextMetadata.mockReturnValue({
      requestId: 'test-request-id',
      duration: 100,
    });
  });

  describe('streaming headers', () => {
    it('should set correct streaming headers', async () => {
      const agent = createMockAgent([]);
      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    });
  });

  describe('successful streaming', () => {
    it('should stream events as NDJSON', async () => {
      const events = [
        { type: 'text', data: 'Hello' },
        { type: 'text', data: ' World' },
      ];
      const agent = createMockAgent(events);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // 2 events + 1 completion event
      expect(res.write).toHaveBeenCalledTimes(3);
    });

    it('should send completion event after streaming', async () => {
      const agent = createMockAgent([{ type: 'text', data: 'Hi' }]);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // Last write before end should be completion event
      const lastWriteCall = res.write.mock.calls[res.write.mock.calls.length - 1][0];
      const completionEvent = JSON.parse(lastWriteCall.trim());
      expect(completionEvent.type).toBe('serverCompletionEvent');
      expect(completionEvent.metadata.requestId).toBe('test-request-id');
    });

    it('should call res.end() after completion', async () => {
      const agent = createMockAgent([]);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('should include metadata in completion event', async () => {
      const agent = createMockAgent([]);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      const lastWrite = res.write.mock.calls[res.write.mock.calls.length - 1][0];
      const event = JSON.parse(lastWrite.trim());
      expect(event.metadata.agentMetadata).toEqual(defaultOptions.metadata);
    });

    it('should pass prompt to agent.stream', async () => {
      const agent = createMockAgent([]);

      await streamAgentResponse(agent, 'Test prompt', undefined, res, defaultOptions);

      expect(agent.stream).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should send error event on streaming error', async () => {
      const agent = createErrorAgent(new Error('Stream failed'));

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // Find the error event write
      const errorWrite = res.write.mock.calls.find((call: any[]) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.type === 'serverErrorEvent';
        } catch {
          return false;
        }
      });

      expect(errorWrite).toBeDefined();
      const errorEvent = JSON.parse(errorWrite[0]);
      expect(errorEvent.type).toBe('serverErrorEvent');
      expect(errorEvent.error.message).toBe('Sanitized error');
    });

    it('should end response after error', async () => {
      const agent = createErrorAgent(new Error('Stream failed'));

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('should save error message to session when session is configured', async () => {
      const mockAppendMessage = jest.fn<any>().mockResolvedValue(undefined);
      const options: StreamOptions = {
        ...defaultOptions,
        sessionStorage: {
          appendMessage: mockAppendMessage,
        } as any,
        sessionConfig: {
          sessionId: 'test-session' as SessionId,
          actorId: 'test-actor' as IdentityId,
        },
      };

      const agent = createErrorAgent(new Error('Stream failed'));

      await streamAgentResponse(agent, 'Hello', undefined, res, options);

      expect(mockAppendMessage).toHaveBeenCalled();
    });

    it('should indicate savedToHistory in error event when session is configured', async () => {
      const options: StreamOptions = {
        ...defaultOptions,
        sessionStorage: {
          appendMessage: jest.fn<any>().mockResolvedValue(undefined),
        } as any,
        sessionConfig: {
          sessionId: 'test-session' as SessionId,
          actorId: 'test-actor' as IdentityId,
        },
      };

      const agent = createErrorAgent(new Error('Stream failed'));

      await streamAgentResponse(agent, 'Hello', undefined, res, options);

      const errorWrite = res.write.mock.calls.find((call: any[]) => {
        try {
          return JSON.parse(call[0]).type === 'serverErrorEvent';
        } catch {
          return false;
        }
      });
      const errorEvent = JSON.parse(errorWrite[0]);
      expect(errorEvent.error.savedToHistory).toBe(true);
    });

    it('should not throw when saving to session fails during error handling', async () => {
      const options: StreamOptions = {
        ...defaultOptions,
        sessionStorage: {
          appendMessage: jest.fn<any>().mockRejectedValue(new Error('Save failed')),
        } as any,
        sessionConfig: {
          sessionId: 'test-session' as SessionId,
          actorId: 'test-actor' as IdentityId,
        },
      };

      const agent = createErrorAgent(new Error('Stream failed'));

      // Should not throw even when session save fails
      await expect(
        streamAgentResponse(agent, 'Hello', undefined, res, options)
      ).resolves.not.toThrow();
    });

    it('should produce valid JSON in all res.write calls when MaxTokensError is thrown', async () => {
      const maxTokensError = new Error('Max tokens exceeded');
      maxTokensError.name = 'MaxTokensError';
      (maxTokensError as any).cause = {
        partialMessage: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'textBlock',
              text: 'Minor Layer 3 update: adding new pattern to LEARNED_PATTERNS, appending Run #4 info to STRATEGY_NOTES and EVOLUTION_LOG',
            },
          ],
        },
      };

      const agent = createErrorAgent(maxTokensError);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // Every res.write call must produce valid JSON — no SyntaxError must be thrown
      for (const call of res.write.mock.calls as [string][]) {
        const written = call[0];
        expect(() => JSON.parse(written.trim())).not.toThrow();
      }
    });

    it('serverErrorEvent message should not contain unescaped partialMessage content', async () => {
      const maxTokensError = new Error('Max tokens exceeded');
      maxTokensError.name = 'MaxTokensError';
      (maxTokensError as any).cause = {
        partialMessage: {
          content: [{ text: 'partial content with "embedded quotes"' }],
        },
      };

      // Override mock to return the actual sanitized message for this test
      mockSanitizeErrorMessage.mockReturnValueOnce('Max tokens exceeded');

      const agent = createErrorAgent(maxTokensError);
      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      const errorWrite = res.write.mock.calls.find((call: any[]) => {
        try {
          return JSON.parse(call[0]).type === 'serverErrorEvent';
        } catch {
          return false;
        }
      });

      expect(errorWrite).toBeDefined();
      const errorEvent = JSON.parse(errorWrite![0]);
      expect(errorEvent.error.message).not.toContain('partial content');
      expect(errorEvent.error.message).not.toContain('embedded quotes');
    });

    // -----------------------------------------------------------------
    // Observability: pino must receive the error under the `err` key so
    // that `stdSerializers.err` captures name/message/stack/cause.
    // Logging under `error` causes the Error class to be serialised as a
    // plain object with only enumerable properties, dropping `message`
    // and `stack` — which is the root cause of the empty
    // `{"error":{"name":"ModelError"}}` log entries reported in issue #8.
    // -----------------------------------------------------------------
    it('logs the streaming error under the `err` key (pino stdSerializers.err contract)', async () => {
      const agent = createErrorAgent(new Error('Stream failed'));

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // Find the call that corresponds to "Agent streaming error:" — i.e.
      // the one whose payload object carries the streaming error.
      const errorLogCall = mockLoggerError.mock.calls.find((call) => {
        const [payload] = call as [any];
        return payload && typeof payload === 'object' && 'err' in payload;
      });

      expect(errorLogCall).toBeDefined();
      const [payload, msg] = errorLogCall as [any, string];
      expect(payload.err).toBeInstanceOf(Error);
      expect(payload.err.message).toBe('Stream failed');
      expect(payload).toHaveProperty('requestId');
      expect(typeof msg).toBe('string');
    });

    it('does NOT log the streaming error under the legacy `error` key', async () => {
      const agent = createErrorAgent(new Error('Stream failed'));

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // No top-level call should pass `error: <Error>` — only `err: <Error>`.
      // (Other unrelated logger.error calls e.g. for session-save failures
      // may still happen; they would not include the Error itself.)
      const wrongShape = mockLoggerError.mock.calls.find((call) => {
        const [payload] = call as [any];
        return (
          payload &&
          typeof payload === 'object' &&
          payload.error instanceof Error &&
          !('err' in payload)
        );
      });

      expect(wrongShape).toBeUndefined();
    });

    it('includes errorName in the serverErrorEvent so the frontend can branch on classification', async () => {
      // Simulate Strands SDK's stream-interruption ModelError. After
      // classifyStreamError() promotes it, the wire event must surface
      // `errorName: "StreamInterruptedError"` (frontend schema uses
      // .passthrough(), so this is a non-breaking addition).
      const interruptError = new Error('Stream ended without completing a message');
      interruptError.name = 'ModelError';

      // Override the classifyStreamError mock just for this test to simulate
      // promotion to StreamInterruptedError. The real implementation is
      // exercised by error-handler.test.ts; here we only verify that
      // stream-handler propagates the classified result into the wire event.
      const promoted: any = new Error('Stream ended without completing a message');
      promoted.name = 'StreamInterruptedError';
      promoted.isRetryable = true;
      promoted.cause = interruptError;
      mockClassifyStreamError.mockImplementationOnce(() => promoted);

      const agent = createErrorAgent(interruptError);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      const errorWrite = res.write.mock.calls.find((call: any[]) => {
        try {
          return JSON.parse(call[0]).type === 'serverErrorEvent';
        } catch {
          return false;
        }
      });
      expect(errorWrite).toBeDefined();
      const errorEvent = JSON.parse(errorWrite![0]);
      expect(errorEvent.error.errorName).toBe('StreamInterruptedError');
      expect(errorEvent.error.isRetryable).toBe(true);
    });
  });

  describe('large event streaming', () => {
    it('should correctly stream all events when there are many', async () => {
      const eventCount = 200;
      const events = Array.from({ length: eventCount }, (_, i) => ({
        type: 'text',
        data: `chunk-${i}`,
      }));
      const agent = createMockAgent(events);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      // eventCount events + 1 completion event
      expect(res.write).toHaveBeenCalledTimes(eventCount + 1);
    });
  });
});
