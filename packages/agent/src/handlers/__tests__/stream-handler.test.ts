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

// ── Register ESM mocks ─────────────────────────────────────────────

jest.unstable_mockModule('../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));

jest.unstable_mockModule('../../libs/utils/index.js', () => ({
  createErrorMessage: mockCreateErrorMessage,
  sanitizeErrorMessage: mockSanitizeErrorMessage,
  serializeStreamEvent: mockSerializeStreamEvent,
  buildInputContent: mockBuildInputContent,
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
  });

  describe('workspace sync status', () => {
    /**
     * Build a fake IWorkspaceSync whose onStatusChange replays `initialStatus`
     * synchronously (mirroring the real adapter) and exposes `push()` so a test
     * can drive later transitions. Attach it to the mocked request context.
     */
    function attachWorkspaceSync(initialStatus: any) {
      let listener: ((s: any) => void) | null = null;
      let current = initialStatus;
      const workspaceSync = {
        getStatus: () => current,
        onStatusChange: (l: (s: any) => void) => {
          listener = l;
          l(current); // synchronous replay, like the real implementation
          return () => {
            listener = null;
          };
        },
        // test helper to emit a later transition
        push: (s: any) => {
          current = s;
          listener?.(s);
        },
      };
      mockGetCurrentContext.mockReturnValue({
        requestId: 'test-request-id',
        userId: 'test-user',
        sessionId: 'test-session' as SessionId,
        workspaceSync,
      });
      return workspaceSync;
    }

    const syncWrites = () =>
      res.write.mock.calls
        .map((c: any[]) => {
          try {
            return JSON.parse(c[0]);
          } catch {
            return null;
          }
        })
        .filter((e: any) => e?.type === 'workspaceSyncEvent');

    it('emits nothing when the request has no workspace sync', async () => {
      // default context (set in beforeEach) has no workspaceSync
      const agent = createMockAgent([{ type: 'text', data: 'Hi' }]);
      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);
      expect(syncWrites()).toHaveLength(0);
    });

    it('stays silent when the pull completes before the debounce elapses', async () => {
      jest.useFakeTimers();
      try {
        attachWorkspaceSync({ phase: 'idle' });
        const agent = createMockAgent([{ type: 'text', data: 'Hi' }]);
        // Stream resolves immediately; complete arrives well before 400ms.
        await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);
        jest.advanceTimersByTime(1000);
        expect(syncWrites()).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('surfaces a sync error immediately regardless of debounce timing', async () => {
      attachWorkspaceSync({ phase: 'error', message: 'S3 down' });
      const agent = createMockAgent([{ type: 'text', data: 'Hi' }]);
      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      const events = syncWrites();
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('error');
      expect(events[0].message).toBe('S3 down');
    });

    it('announces syncing after the debounce and then completion', async () => {
      jest.useFakeTimers();
      try {
        const ws = attachWorkspaceSync({
          phase: 'syncing',
          progress: { phase: 'download', current: 10, total: 100, percentage: 10 },
        });
        // Hold the stream open until we manually advance timers + resolve.
        const agent = createMockAgent([{ type: 'text', data: 'Hi' }]);
        const promise = streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

        // Debounce fires → the initial syncing line is emitted.
        jest.advanceTimersByTime(400);
        // A later progress update streams live, then completion.
        ws.push({
          phase: 'syncing',
          progress: { phase: 'download', current: 60, total: 100, percentage: 60 },
        });
        ws.push({ phase: 'complete' });

        await promise;

        const events = syncWrites();
        expect(events[0]).toMatchObject({ status: 'syncing', percentage: 10 });
        expect(events.some((e: any) => e.status === 'syncing' && e.percentage === 60)).toBe(true);
        expect(events[events.length - 1].status).toBe('complete');
      } finally {
        jest.useRealTimers();
      }
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
