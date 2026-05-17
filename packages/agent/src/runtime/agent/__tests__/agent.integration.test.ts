/**
 * Agent Factory Integration Tests
 *
 * End-to-end tests for createAgent() with actual AWS Bedrock connections.
 * These tests are conditionally skipped when required environment variables
 * are not configured.
 *
 * Required env vars:
 * - AGENTCORE_GATEWAY_ENDPOINT: Gateway endpoint for tool fetching
 *
 * Run: cd packages/agent && npm run test:integration -- agent.integration
 */

import { it, expect } from '@jest/globals';
import { describeIfEnv } from '../../tests/integration-helpers.js';
import { createAgent } from '../../../agent.js';

const describeWithGateway = describeIfEnv(
  ['AGENTCORE_GATEWAY_ENDPOINT'],
  'createAgent integration'
);

describeWithGateway('createAgent integration', () => {
  it('should create an agent with default options', async () => {
    const result = await createAgent();

    expect(result.agent).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.toolsCount).toBeGreaterThanOrEqual(0);
    expect(result.metadata.loadedMessagesCount).toBe(0);
    expect(result.metadata.longTermMemoriesCount).toBe(0);
  });

  it('should create an agent with specific tools enabled', async () => {
    const result = await createAgent({
      enabledTools: ['think'],
    });

    expect(result.agent).toBeDefined();
    expect(result.metadata.toolsCount).toBeGreaterThanOrEqual(0);
  });

  it('should create an agent with no tools when enabledTools is empty', async () => {
    const result = await createAgent({
      enabledTools: [],
    });

    expect(result.agent).toBeDefined();
    expect(result.metadata.toolsCount).toBe(0);
  });

  it('should create an agent with custom system prompt', async () => {
    const result = await createAgent({
      systemPrompt: 'You are a test assistant. Always respond with PONG.',
      enabledTools: [],
    });

    expect(result.agent).toBeDefined();
  });

  it('should create an agent and stream a simple response', async () => {
    const result = await createAgent({
      systemPrompt:
        'Always respond with exactly the word PONG when the user says PING. No other text.',
      enabledTools: [],
    });

    const events: unknown[] = [];
    for await (const event of result.agent.stream('PING')) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(result.agent.messages).toHaveLength(2);
    expect(result.agent.messages[0].role).toBe('user');
    expect(result.agent.messages[1].role).toBe('assistant');
  });
});
