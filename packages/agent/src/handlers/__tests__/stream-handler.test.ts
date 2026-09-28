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
// The cancel registry is a dependency-free module singleton; use the real one
// so we can assert this turn's Agent gets registered / unregistered.
const { isRegistered, cancelAgent, resetRegistry } = await import(
  '../../libs/health/agent-cancel-registry.js'
);
import type { IdentityId, SessionId } from '@moca/core';

/**
 * Create a mock Express Response.
 *
 * Supports `once`/`on`/`emit` so tests can simulate a client disconnect
 * (`res.emit('close')`). `end()` flips `writableEnded` to mirror Express, so
 * the handler's "close after finish is benign" guard can be exercised.
 */
function createMockResponse() {
  const listeners: Record<string, () => void> = {};
  const res: any = {
    setHeader: jest.fn(),
    write: jest.fn(),
    writableEnded: false,
    end: jest.fn(() => {
      res.writableEnded = true;
    }),
    once: jest.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
      return res;
    }),
    on: jest.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
      return res;
    }),
    emit: (event: string) => listeners[event]?.(),
  };
  return res;
}

/**
 * Create a mock Agent with configurable stream behavior.
 *
 * `agent.stream()` returns a real async generator whose *return value* is the
 * `AgentResult` (carrying `stopReason`) — matching the SDK contract that the
 * handler reads to distinguish a cancelled turn from a completed one.
 */
function createMockAgent(
  events: unknown[] = [{ type: 'text', data: 'Hello' }],
  result: { stopReason?: string } = { stopReason: 'endTurn' }
) {
  return {
    messages: [{ role: 'user' }, { role: 'assistant' }],
    cancel: jest.fn(),
    stream: jest.fn().mockImplementation(() =>
      (async function* () {
        for (const event of events) {
          yield event;
        }
        return result;
      })()
    ),
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
    resetRegistry();
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

  describe('cancellation', () => {
    it('registers the agent in the cancel registry while a turn is in flight', async () => {
      // A stream that parks mid-turn, so we can observe the registration before
      // the turn settles.
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const agent = {
        messages: [],
        cancel: jest.fn(),
        stream: jest.fn().mockImplementation(() =>
          (async function* () {
            yield { type: 'text', data: 'partial' };
            await gate;
            return { stopReason: 'endTurn' };
          })()
        ),
      } as any;

      const promise = streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);
      await Promise.resolve();

      // The registry now holds this turn's agent, so a stop command targeting
      // 'test-session' can reach it.
      expect(isRegistered('test-session')).toBe(true);

      releaseGate();
      await promise;
    });

    it('a registry cancel drives the turn to stopReason cancelled', async () => {
      // Real cancellation path: agent.cancel() (invoked via the registry by the
      // stop command) makes the parked stream resolve as cancelled.
      let aborted = false;
      const agent = {
        messages: [],
        cancel: jest.fn(() => {
          aborted = true;
        }),
        stream: jest.fn().mockImplementation(() =>
          (async function* () {
            yield { type: 'text', data: 'partial' };
            // Poll the cancel flag the way the SDK checks its internal signal.
            while (!aborted) await new Promise((r) => setTimeout(r, 5));
            return { stopReason: 'cancelled' };
          })()
        ),
      } as any;

      const promise = streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);
      await Promise.resolve();

      // Simulate the stop command landing on this microVM.
      expect(cancelAgent('test-session')).toBe(true);
      expect(agent.cancel).toHaveBeenCalledTimes(1);

      await promise;

      const writes = res.write.mock.calls.map((c: any[]) => JSON.parse(c[0].trim()));
      expect(writes.map((w: any) => w.type)).toContain('serverCancelledEvent');
    });

    it('unregisters the agent after the turn settles', async () => {
      const agent = createMockAgent([]);

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      expect(isRegistered('test-session')).toBe(false);
    });

    it('should emit serverCancelledEvent (not completion) when stopReason is cancelled', async () => {
      const agent = createMockAgent([{ type: 'text', data: 'partial' }], {
        stopReason: 'cancelled',
      });

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      const writes = res.write.mock.calls.map((c: any[]) => JSON.parse(c[0].trim()));
      const types = writes.map((w: any) => w.type);
      expect(types).toContain('serverCancelledEvent');
      expect(types).not.toContain('serverCompletionEvent');
    });

    it('should not treat a cancelled turn as an error', async () => {
      const mockAppendMessage = jest.fn<any>().mockResolvedValue(undefined);
      const options: StreamOptions = {
        ...defaultOptions,
        sessionStorage: { appendMessage: mockAppendMessage } as any,
        sessionConfig: {
          sessionId: 'test-session' as SessionId,
          actorId: 'test-actor' as IdentityId,
        },
      };
      const agent = createMockAgent([{ type: 'text', data: 'partial' }], {
        stopReason: 'cancelled',
      });

      await streamAgentResponse(agent, 'Hello', undefined, res, options);

      const writes = res.write.mock.calls.map((c: any[]) => JSON.parse(c[0].trim()));
      expect(writes.map((w: any) => w.type)).not.toContain('serverErrorEvent');
      // Cancellation history integrity is the SDK's responsibility (it appends a
      // synthetic assistant/tool-result), so the handler must NOT write its own
      // error message into session history.
      expect(mockAppendMessage).not.toHaveBeenCalled();
    });

    it('should end the response after a cancelled turn', async () => {
      const agent = createMockAgent([{ type: 'text', data: 'partial' }], {
        stopReason: 'cancelled',
      });

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('should still stream events that arrived before cancellation', async () => {
      const agent = createMockAgent(
        [
          { type: 'text', data: 'chunk-1' },
          { type: 'text', data: 'chunk-2' },
        ],
        { stopReason: 'cancelled' }
      );

      await streamAgentResponse(agent, 'Hello', undefined, res, defaultOptions);

      const writes = res.write.mock.calls.map((c: any[]) => JSON.parse(c[0].trim()));
      expect(writes.filter((w: any) => w.type === 'text')).toHaveLength(2);
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
