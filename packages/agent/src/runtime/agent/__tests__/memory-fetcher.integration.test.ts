/**
 * Memory Fetcher Integration Tests
 *
 * Tests fetchLongTermMemories() with actual AgentCore Memory API.
 * Conditionally skipped when AGENTCORE_MEMORY_ID is not configured.
 *
 * Required env vars:
 * - AGENTCORE_MEMORY_ID: AgentCore Memory resource ID
 *
 * Run: cd packages/agent && npm run test:integration -- memory-fetcher.integration
 */

import { it, expect } from '@jest/globals';
import { describeIfEnv } from '../../tests/integration-helpers.js';
import { fetchLongTermMemories } from '../memory-fetcher.js';

const describeWithMemory = describeIfEnv(['AGENTCORE_MEMORY_ID'], 'Memory fetcher integration');

describeWithMemory('fetchLongTermMemories integration', () => {
  it('should retrieve memories from AgentCore Memory', async () => {
    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: 'integration-test-user',
      context: 'What have we discussed before?',
      topK: 5,
    });

    // The result should have the correct shape regardless of actual data
    expect(result).toBeDefined();
    expect(result.memories).toBeInstanceOf(Array);
    expect(result.conditions).toBeDefined();
    expect(result.conditions.memoryEnabled).toBe(true);
    expect(result.conditions.hasActorId).toBe(true);
    expect(result.conditions.hasMemoryContext).toBe(true);
    expect(result.conditions.hasMemoryId).toBe(true);
  });

  it('should return empty memories when disabled even with valid config', async () => {
    const result = await fetchLongTermMemories({
      enabled: false,
      actorId: 'integration-test-user',
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.memoryEnabled).toBe(false);
  });

  it('should handle missing actorId gracefully', async () => {
    const result = await fetchLongTermMemories({
      enabled: true,
      actorId: undefined,
      context: 'test query',
    });

    expect(result.memories).toEqual([]);
    expect(result.conditions.hasActorId).toBe(false);
  });
});
