/**
 * Cache-Aware Model Integration Tests
 *
 * Verifies that createBedrockModel correctly resolves cachePrompt / cacheTools
 * based on per-model capabilities, preventing "extraneous key [cachePoint]"
 * errors on models that do not support tool caching.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 *
 * Run: cd packages/agent && npm run test:integration -- cache-aware-model
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, BedrockModel, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { createBedrockModel } from '../../models/bedrock.js';

const REGION = process.env.BEDROCK_REGION || 'us-east-1';

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
// Nova models — cacheTools NOT supported
// ---------------------------------------------------------------------------

describe('Amazon Nova + tools (cacheTools not supported)', () => {
  it('fails when cacheTools is explicitly set on Nova Lite', async () => {
    // Arrange — bypass createBedrockModel to prove the raw error
    const model = new BedrockModel({
      region: REGION,
      modelId: 'amazon.nova-lite-v1:0',
      cacheTools: 'default',
    });

    const agent = new Agent({
      model,
      systemPrompt: 'Be brief.',
      tools: [dummyTool],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 10 }),
    });

    let caughtError: Error | undefined;
    try {
      for await (const event of agent.stream('What time is it?')) {
        void event;
      }
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toMatch(/cachePoint|Malformed input/i);
  });

  it('succeeds with Nova Lite via createBedrockModel (cacheTools auto-disabled)', async () => {
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
    // Verify that createBedrockModel works for Nova even without tools
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
// Claude models — cacheTools supported
// ---------------------------------------------------------------------------

describe('Claude + tools (cacheTools supported)', () => {
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
