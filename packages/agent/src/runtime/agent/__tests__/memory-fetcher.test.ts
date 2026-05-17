/**
 * Memory Fetcher Unit Tests
 *
 * Tests for extractMemoryParams() and fetchLongTermMemories()
 * which handle long-term memory retrieval from AgentCore Memory.
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { IdentityId } from '@moca/core';

// Test fixtures — cast raw strings to `IdentityId` so the tests can exercise
// `extractMemoryParams` / `fetchLongTermMemories` with arbitrary values
// (including the empty string) without having to fabricate a real
// `REGION:UUID` identity. The runtime code treats `actorId` as an opaque
// string, so the brand only matters at the type level.
const TEST_ACTOR_ID = 'user-123' as IdentityId;
const EMPTY_ACTOR_ID = '' as IdentityId;

// ── Mock definitions ───────────────────────────────────────────────────

const mockRetrieveLongTermMemory = jest
  .fn<
    (
      memoryId: string,
      actorId: string,
      memoryStrategyId: string,
      query: string,
      topK: number,
      client: unknown
    ) => Promise<string[]>
  >()
  .mockResolvedValue([]);

const mockCreateUserScopedBedrockAgentCoreClient = jest
  .fn<(identityId: string) => Promise<object>>()
  .mockResolvedValue({});

// ── Register ESM mocks ─────────────────────────────────────────────────

const mockConfig = {
  AGENTCORE_MEMORY_ID: 'test-memory-id',
  AGENTCORE_SEMANTIC_STRATEGY_ID: 'semantic_memory_strategy-XyZ123',
  BEDROCK_REGION: 'us-east-1',
};

jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  config: mockConfig,
}));

jest.unstable_mockModule('../../../services/session/memory-retriever.js', () => ({
  retrieveLongTermMemory: mockRetrieveLongTermMemory,
}));

jest.unstable_mockModule('../../../libs/utils/scoped-credentials.js', () => ({
  createUserScopedBedrockAgentCoreClient: mockCreateUserScopedBedrockAgentCoreClient,
}));

// ── Dynamic imports ────────────────────────────────────────────────────

const { extractMemoryParams, fetchLongTermMemories } = await import('../memory-fetcher.js');

describe('extractMemoryParams', () => {
  it('should return defaults when options is undefined', () => {
    const result = extractMemoryParams(undefined);
    expect(result).toEqual({
      enabled: false,
      actorId: undefined,
      context: undefined,
      topK: undefined,
    });
  });

  it('should return defaults when options is empty object', () => {
    const result = extractMemoryParams({});
    expect(result).toEqual({
      enabled: false,
      actorId: undefined,
      context: undefined,
      topK: undefined,
    });
  });

  it('should extract all parameters when provided', () => {
    const result = extractMemoryParams({
      memoryEnabled: true,
      actorId: TEST_ACTOR_ID,
      memoryContext: 'What is AI?',
      memoryTopK: 5,
    });
    expect(result).toEqual({
      enabled: true,
      actorId: 'user-123',
      context: 'What is AI?',
      topK: 5,
    });
  });

  it('should treat memoryEnabled=false as disabled', () => {
    const result = extractMemoryParams({ memoryEnabled: false });
    expect(result.enabled).toBe(false);
  });

  it('should treat memoryEnabled=undefined as disabled', () => {
    const result = extractMemoryParams({ memoryEnabled: undefined });
    expect(result.enabled).toBe(false);
  });
});

describe('fetchLongTermMemories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset config to default values
    mockConfig.AGENTCORE_MEMORY_ID = 'test-memory-id';
    mockConfig.AGENTCORE_SEMANTIC_STRATEGY_ID = 'semantic_memory_strategy-XyZ123';
    mockConfig.BEDROCK_REGION = 'us-east-1';
    mockCreateUserScopedBedrockAgentCoreClient.mockResolvedValue({});
  });

  it('should return empty memories when disabled', async () => {
    const result = await fetchLongTermMemories({
      enabled: false,
      actorId: TEST_ACTOR_ID,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.memoryEnabled).toBe(false);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should return empty memories when AGENTCORE_MEMORY_ID is not configured', async () => {
    mockConfig.AGENTCORE_MEMORY_ID = '';

    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.hasMemoryId).toBe(false);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should return empty memories when AGENTCORE_SEMANTIC_STRATEGY_ID is not configured', async () => {
    mockConfig.AGENTCORE_SEMANTIC_STRATEGY_ID = '';

    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should return empty memories when actorId is missing', async () => {
    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: undefined,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.hasActorId).toBe(false);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should return empty memories when context is missing', async () => {
    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: undefined,
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.hasMemoryContext).toBe(false);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should retrieve memories when all conditions are met', async () => {
    const expectedMemories = ['Memory 1: User likes TypeScript', 'Memory 2: Previous project'];
    mockRetrieveLongTermMemory.mockResolvedValue(expectedMemories);

    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: 'What is TypeScript?',
      topK: 5,
    });

    expect(result.memories).toEqual(expectedMemories);
    expect(result.conditions).toEqual({
      memoryEnabled: true,
      hasActorId: true,
      hasMemoryContext: true,
      hasMemoryId: true,
    });
    expect(mockCreateUserScopedBedrockAgentCoreClient).toHaveBeenCalledWith('user-123');
    expect(mockRetrieveLongTermMemory).toHaveBeenCalledWith(
      'test-memory-id',
      'user-123',
      'semantic_memory_strategy-XyZ123',
      'What is TypeScript?',
      5,
      expect.any(Object)
    );
  });

  it('should use default topK of 10 when not specified', async () => {
    mockRetrieveLongTermMemory.mockResolvedValue([]);

    await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: 'test query',
    });

    expect(mockRetrieveLongTermMemory).toHaveBeenCalledWith(
      'test-memory-id',
      'user-123',
      'semantic_memory_strategy-XyZ123',
      'test query',
      10,
      expect.any(Object)
    );
  });

  it('should return empty memories when retrieveLongTermMemory throws', async () => {
    // fetchLongTermMemories now catches errors and returns empty memories so
    // that a failed Memory call does not tear down the entire agent
    // invocation. The error path is still logged via the logger.
    mockRetrieveLongTermMemory.mockRejectedValue(new Error('Memory API error'));

    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
  });

  it('should return empty memories when actorId is empty string', async () => {
    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: EMPTY_ACTOR_ID,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.hasActorId).toBe(false);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should return empty memories when context is empty string', async () => {
    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: TEST_ACTOR_ID,
      context: '',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.hasMemoryContext).toBe(false);
    expect(mockRetrieveLongTermMemory).not.toHaveBeenCalled();
  });

  it('should set correct conditions object for all checks', async () => {
    const result = await fetchLongTermMemories({
      enabled: false,
      actorId: TEST_ACTOR_ID,
      context: 'test',
    });

    expect(result.conditions).toEqual({
      memoryEnabled: false,
      hasActorId: true,
      hasMemoryContext: true,
      hasMemoryId: true,
    });
  });
});
