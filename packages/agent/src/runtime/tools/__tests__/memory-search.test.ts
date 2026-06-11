/**
 * Unit tests for the memory_search tool handler (runMemorySearch).
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 * All identity / AWS access is mocked; the focus is the mode dispatch,
 * per-mode validation, range windowing, and that the actorId is taken from
 * request context (never from tool input).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Message, TextBlock, ToolUseBlock } from '@strands-agents/sdk';
import type { IdentityId } from '@moca/core';

const ACTOR_ID = 'us-east-1:11111111-2222-3333-4444-555555555555' as IdentityId;

// ── Mocks ──────────────────────────────────────────────────────────────
const mockGetCurrentContext = jest.fn<() => { identityId?: IdentityId } | undefined>();
const mockRetrieveLongTermMemory =
  jest.fn<(...args: unknown[]) => Promise<string[]>>().mockResolvedValue([]);
const mockCreateClient = jest
  .fn<(id: string) => Promise<object>>()
  .mockResolvedValue({});
const mockLoadMessages = jest.fn<() => Promise<Message[]>>().mockResolvedValue([]);
const mockListSessions = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIsConfigured = jest.fn<() => boolean>().mockReturnValue(true);

const mockConfig = {
  AGENTCORE_MEMORY_ID: 'test-memory-id',
  AGENTCORE_SEMANTIC_STRATEGY_ID: 'semantic_memory_strategy-XyZ123',
};

jest.unstable_mockModule('../../../config/index.js', () => ({
  config: mockConfig,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
}));
jest.unstable_mockModule('../../../libs/utils/scoped-credentials.js', () => ({
  createUserScopedBedrockAgentCoreClient: mockCreateClient,
}));
jest.unstable_mockModule('../../../services/session/memory-retriever.js', () => ({
  retrieveLongTermMemory: mockRetrieveLongTermMemory,
}));
jest.unstable_mockModule('../../../services/session/index.js', () => ({
  AgentCoreMemoryStorage: class {
    loadMessages = mockLoadMessages;
  },
}));
jest.unstable_mockModule('../../../services/sessions-service.js', () => ({
  getSessionsService: () => ({
    isConfigured: mockIsConfigured,
    listSessions: mockListSessions,
  }),
}));

const { runMemorySearch } = await import('../memory-search.js');

/** Build N alternating user/assistant text messages. */
function makeMessages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    new Message({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [new TextBlock(`message ${i}`)],
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCurrentContext.mockReturnValue({ identityId: ACTOR_ID });
  mockIsConfigured.mockReturnValue(true);
  mockRetrieveLongTermMemory.mockResolvedValue([]);
  mockLoadMessages.mockResolvedValue([]);
});

describe('runMemorySearch', () => {
  it('returns an identity error when the request context has no identityId', async () => {
    mockGetCurrentContext.mockReturnValue({});
    const result = await runMemorySearch({ mode: 'search', query: 'x' });
    expect(result).toContain('Could not determine the current user identity');
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  describe("mode 'search'", () => {
    it('requires a non-empty query', async () => {
      const result = await runMemorySearch({ mode: 'search', query: '   ' });
      expect(result).toContain("requires a non-empty 'query'");
      expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
    });

    it('returns formatted memories scoped to the context actorId', async () => {
      mockRetrieveLongTermMemory.mockResolvedValue(['likes TypeScript', 'prefers concise replies']);
      const result = await runMemorySearch({ query: 'preferences' });
      expect(result).toContain('Found 2 relevant memory record(s)');
      expect(result).toContain('1. likes TypeScript');
      // actorId passed to retrieval comes from context, not input
      expect(mockRetrieveLongTermMemory).toHaveBeenCalledWith(
        'test-memory-id',
        ACTOR_ID,
        'semantic_memory_strategy-XyZ123',
        'preferences',
        10,
        expect.anything()
      );
    });

    it('reports when no memories are found', async () => {
      mockRetrieveLongTermMemory.mockResolvedValue([]);
      const result = await runMemorySearch({ query: 'nothing' });
      expect(result).toContain('No memories found');
    });
  });

  describe("mode 'list_sessions'", () => {
    it('warns when the sessions table is not configured', async () => {
      mockIsConfigured.mockReturnValue(false);
      const result = await runMemorySearch({ mode: 'list_sessions' });
      expect(result).toContain('not configured');
      expect(mockListSessions).not.toHaveBeenCalled();
    });

    it('reports an empty list', async () => {
      mockListSessions.mockResolvedValue({ sessions: [], hasMore: false });
      const result = await runMemorySearch({ mode: 'list_sessions' });
      expect(result).toContain('No past sessions found');
    });

    it('formats sessions and surfaces the nextToken', async () => {
      mockListSessions.mockResolvedValue({
        sessions: [
          {
            sessionId: 's-1',
            title: 'First chat',
            agentId: 'a-1',
            sessionType: 'user',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ],
        nextToken: 'TOKEN123',
        hasMore: true,
      });
      const result = await runMemorySearch({ mode: 'list_sessions', limit: 1 });
      expect(result).toContain('First chat');
      expect(result).toContain('sessionId: s-1');
      expect(result).toContain("nextToken='TOKEN123'");
      expect(mockListSessions).toHaveBeenCalledWith(ACTOR_ID, 1, undefined);
    });

    it('maps an invalid pagination token to a friendly message', async () => {
      mockListSessions.mockRejectedValue(new Error('Invalid pagination token'));
      const result = await runMemorySearch({ mode: 'list_sessions', nextToken: 'bad' });
      expect(result).toContain('Invalid nextToken');
    });
  });

  describe("mode 'read_session'", () => {
    it('requires a sessionId', async () => {
      const result = await runMemorySearch({ mode: 'read_session' });
      expect(result).toContain("requires a 'sessionId'");
      expect(mockLoadMessages).not.toHaveBeenCalled();
    });

    it('reports an empty/inaccessible session', async () => {
      mockLoadMessages.mockResolvedValue([]);
      const result = await runMemorySearch({ mode: 'read_session', sessionId: 's-x' });
      expect(result).toContain('has no messages');
    });

    it('returns the most recent 20 messages and the total when range is omitted', async () => {
      mockLoadMessages.mockResolvedValue(makeMessages(25));
      const result = await runMemorySearch({ mode: 'read_session', sessionId: 's-1' });
      expect(result).toContain('[5, 25) of 25 total');
      expect(result).toContain('[24] User'); // index 24 is even → user role
      expect(result).not.toContain('[4] '); // older messages excluded
    });

    it('returns the full transcript when there are fewer than 20 messages', async () => {
      mockLoadMessages.mockResolvedValue(makeMessages(3));
      const result = await runMemorySearch({ mode: 'read_session', sessionId: 's-1' });
      expect(result).toContain('[0, 3) of 3 total');
      expect(result).toContain('This is the full transcript.');
    });

    it('honours an explicit range window', async () => {
      mockLoadMessages.mockResolvedValue(makeMessages(50));
      const result = await runMemorySearch({
        mode: 'read_session',
        sessionId: 's-1',
        range: [10, 15],
      });
      expect(result).toContain('[10, 15) of 50 total');
      expect(result).toContain('[10] User');
      expect(result).toContain('[14] User');
      expect(result).not.toContain('[15] ');
    });

    it('caps an over-large range to 20 messages per call', async () => {
      mockLoadMessages.mockResolvedValue(makeMessages(100));
      const result = await runMemorySearch({
        mode: 'read_session',
        sessionId: 's-1',
        range: [0, 100],
      });
      expect(result).toContain('[0, 20) of 100 total');
    });

    it('summarises non-text content blocks in the transcript', async () => {
      mockLoadMessages.mockResolvedValue([
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'execute_command', toolUseId: 't1', input: {} })],
        }),
      ]);
      const result = await runMemorySearch({ mode: 'read_session', sessionId: 's-1' });
      expect(result).toContain('[tool_use: execute_command]');
    });
  });
});
