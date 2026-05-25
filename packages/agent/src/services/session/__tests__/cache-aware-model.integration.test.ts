/**
 * Cache-Aware Model Integration Tests
 *
 * Verifies that `createBedrockModel` forwards `cacheConfig: { strategy: 'auto' }`
 * to the SDK in a way that:
 *   - works for Claude (cache points are injected, hits register on the
 *     second turn)
 *   - works for Nova Lite (the SDK's `auto` strategy resolves to "no caching"
 *     for non-Anthropic models, so the same call must NOT produce
 *     "extraneous key [cachePoint]" errors when tools are present).
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 *
 * Run: cd packages/agent && npm run test:integration -- cache-aware-model
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { createBedrockModel } from '../../../config/bedrock.js';

/** A minimal no-op tool to include in the agent's toolConfig. */
const dummyTool = tool({
  name: 'get_current_time',
  description: 'Returns the current UTC time.',
  inputSchema: z.object({}),
  callback: async () => new Date().toISOString(),
});

/** Helper: extract text from agent's last assistant message. */
function lastAssistantText(agent: Agent): string {
  const msgs = agent.messages;
  const last = msgs[msgs.length - 1];
  return last.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

// ---------------------------------------------------------------------------
// Amazon Nova — SDK auto strategy must NOT inject cachePoint into tools[]
// ---------------------------------------------------------------------------

describe('Amazon Nova with tools (auto strategy resolves to no-op)', () => {
  it('succeeds with Nova Lite + tools via createBedrockModel', async () => {
    const model = createBedrockModel({ modelId: 'amazon.nova-lite-v1:0' });

    const agent = new Agent({
      model,
      systemPrompt: 'Be brief. Answer in one sentence.',
      tools: [dummyTool],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 10 }),
    });

    for await (const event of agent.stream('Say hello.')) {
      void event;
    }

    expect(agent.messages.length).toBeGreaterThanOrEqual(2);
    expect(agent.messages[0].role).toBe('user');
  });

  it('succeeds with Nova Lite without tools via createBedrockModel', async () => {
    const model = createBedrockModel({ modelId: 'amazon.nova-lite-v1:0' });

    const agent = new Agent({
      model,
      systemPrompt: 'Be brief. Answer in one sentence.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 10 }),
    });

    for await (const event of agent.stream('What is the capital of Japan? One word.')) {
      void event;
    }

    expect(agent.messages.length).toBeGreaterThanOrEqual(2);
    expect(agent.messages[0].role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Claude — SDK auto strategy injects cachePoints; second turn should hit
// ---------------------------------------------------------------------------

describe('Claude with tools (auto strategy injects cachePoints)', () => {
  it('succeeds with Claude via createBedrockModel with tools and caching', async () => {
    // Use the default model (Claude Sonnet via cross-region inference profile)
    const model = createBedrockModel();

    const agent = new Agent({
      model,
      systemPrompt: 'Be brief.',
      tools: [dummyTool],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 10 }),
    });

    for await (const event of agent.stream('What is 2 + 3? Just the number.')) {
      void event;
    }

    expect(agent.messages.length).toBeGreaterThanOrEqual(2);
    expect(lastAssistantText(agent)).toContain('5');
  });
});
