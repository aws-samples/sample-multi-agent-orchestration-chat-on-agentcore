/**
 * Session Loader Integration Tests
 *
 * Verifies that loadSessionHistory() with CONVERSATION_WINDOW_SIZE correctly
 * pre-truncates loaded session history, and that the resulting messages array
 * can be passed to `new Agent({ messages })` to successfully hold a conversation.
 *
 * Fix for Issue #357: unbounded session history caused 400K+ token context windows
 * and 80–255s Bedrock latency spikes.
 *
 * Run: cd packages/agent && NODE_OPTIONS='--experimental-vm-modules --no-warnings' \
 *      npx jest --config jest.session-loader.integration.config.js --forceExit
 */

import { describe, it, expect } from '@jest/globals';
import {
  Agent,
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  SlidingWindowConversationManager,
  tool,
} from '@strands-agents/sdk';
import { z } from 'zod';
import { config, createBedrockModel } from '../../../config/index.js';
import { loadSessionHistory, applyWindowTruncation } from '../session-loader.js';
import type { SessionStorage, SessionConfig } from '../../../services/session/types.js';
import type { IdentityId, SessionId } from '@moca/core';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** Build N user/assistant pairs of plain text messages. */
function buildPlainHistory(pairs: number, charsPerMessage = 400): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push(
      new Message({
        role: 'user',
        content: [
          new TextBlock(
            `Question ${i + 1}: ` +
              'Lorem ipsum dolor sit amet, consectetur adipiscing. '.repeat(
                Math.ceil(charsPerMessage / 52)
              )
          ),
        ],
      }),
      new Message({
        role: 'assistant',
        content: [
          new TextBlock(
            `Answer ${i + 1}: ` +
              'The quick brown fox jumps over the lazy dog. '.repeat(
                Math.ceil(charsPerMessage / 45)
              )
          ),
        ],
      })
    );
  }
  return messages;
}

/** Build a history that includes toolUse / toolResult cycles at the end. */
function buildHistoryWithToolPairs(plainPairs: number, toolPairs: number): Message[] {
  const messages = buildPlainHistory(plainPairs, 200);

  for (let i = 0; i < toolPairs; i++) {
    const toolUseId = `tu-${i + 1}`;
    messages.push(
      new Message({ role: 'user', content: [new TextBlock(`Please run tool step ${i + 1}`)] }),
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({
            toolUseId,
            name: 'calculator',
            input: { expression: `${i} + 1` },
          }),
        ],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId,
            content: [{ type: 'textBlock' as const, text: String(i + 1) }],
            status: 'success',
          }),
        ],
      }),
      new Message({
        role: 'assistant',
        content: [new TextBlock(`Tool step ${i + 1} result: ${i + 1}`)],
      })
    );
  }

  return messages;
}

/**
 * Build a mock SessionStorage backed by an in-memory messages array.
 * Simulates AgentCore Memory without requiring actual AWS credentials for storage.
 */
function buildMockStorage(storedMessages: Message[]): {
  storage: SessionStorage;
  config: SessionConfig;
} {
  const storage: SessionStorage = {
    loadMessages: async () => storedMessages as unknown as Message[],
    saveMessages: async () => {},
    appendMessage: async () => {},
    clearSession: async () => {},
  };

  const sessionConfig: SessionConfig = {
    sessionId: 'test-session-id' as SessionId,
    actorId: 'test-actor-id' as IdentityId,
  };

  return { storage, config: sessionConfig };
}

/** Send a message via stream and consume all events. */
async function chat(agent: Agent, prompt: string): Promise<void> {
  for await (const event of agent.stream(prompt)) {
    void event;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadSessionHistory with CONVERSATION_WINDOW_SIZE → Agent new → conversation', () => {
  /**
   * Core fix for Issue #357:
   *
   * Simulates the actual createAgent() flow:
   *   1. loadSessionHistory() with CONVERSATION_WINDOW_SIZE truncates a large history
   *   2. The truncated messages array is passed to `new Agent({ messages })`
   *   3. The agent successfully holds a conversation via Bedrock
   *
   * CONVERSATION_WINDOW_SIZE defaults to 40 (from config/index.ts).
   * The stored history has 200 messages — far exceeding the window.
   */
  it('truncates large history to CONVERSATION_WINDOW_SIZE and agent new + chat succeeds', async () => {
    // Arrange — simulate 200 messages stored in AgentCore Memory
    const storedMessages = buildPlainHistory(100, 400); // 200 messages
    expect(storedMessages).toHaveLength(200);

    const { storage, config: sessionCfg } = buildMockStorage(storedMessages);
    const windowSize = config.CONVERSATION_WINDOW_SIZE; // default: 40

    // Act (Step 1) — loadSessionHistory with CONVERSATION_WINDOW_SIZE (the Fix 1 call path)
    const messages = await loadSessionHistory(storage, sessionCfg, windowSize);

    // Verify truncation occurred
    expect(messages.length).toBeLessThanOrEqual(windowSize);
    expect(messages[0].role).toBe('user'); // first message must be user

    // Act (Step 2) — new Agent({ messages }) must succeed without error
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize,
        shouldTruncateResults: true,
      }),
    });

    // Act (Step 3) — actual Bedrock call must succeed
    await chat(agent, 'What is 3 + 4? Just the number.');

    // Assert — conversation succeeded
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('7');
    // Message count stays within window bounds
    expect(agent.messages.length).toBeLessThanOrEqual(windowSize + 2);
  });

  /**
   * Verifies that when the stored history ends with toolUse/toolResult pairs,
   * loadSessionHistory() does not split the pair at the truncation boundary,
   * and the resulting messages array allows `new Agent` + conversation to succeed.
   */
  it('skips toolUse/toolResult pair at boundary — Agent new + chat succeeds', async () => {
    // Arrange — 20 plain + 12 tool-cycle messages = 32 total
    const storedMessages = buildHistoryWithToolPairs(10, 3);
    const { storage, config: sessionCfg } = buildMockStorage(storedMessages);

    const dummyCalculator = tool({
      name: 'calculator',
      description: 'A simple calculator',
      inputSchema: z.object({ expression: z.string() }),
      callback: async (input: { expression: string }) => `result: ${input.expression}`,
    });

    const windowSize = config.CONVERSATION_WINDOW_SIZE;

    // Act (Step 1) — loadSessionHistory truncates and avoids splitting the pair
    const messages = await loadSessionHistory(storage, sessionCfg, windowSize);

    // The first message must never be a toolResultBlock
    const firstHasToolResult = messages[0]?.content.some(
      (b) => (b as { type: string }).type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);

    // Act (Step 2) — new Agent({ messages }) must succeed without error
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt:
        'You are a helpful assistant. You have access to a calculator tool but it is optional.',
      tools: [dummyCalculator],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize,
        shouldTruncateResults: true,
      }),
    });

    // Act (Step 3) — actual Bedrock call must succeed
    await chat(agent, 'What is 100 + 200? Just the number.');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('300');
  });

  /**
   * Verifies that the fix holds across multiple conversation turns:
   * After loadSessionHistory() truncates history and Agent is created,
   * the SlidingWindowConversationManager keeps subsequent turns bounded.
   */
  it('multi-turn conversation stays bounded after loadSessionHistory truncation', async () => {
    // Arrange — 60 messages in storage
    const storedMessages = buildPlainHistory(30, 300);
    const { storage, config: sessionCfg } = buildMockStorage(storedMessages);

    const windowSize = config.CONVERSATION_WINDOW_SIZE;

    // Act (Step 1) — loadSessionHistory with CONVERSATION_WINDOW_SIZE
    const messages = await loadSessionHistory(storage, sessionCfg, windowSize);

    expect(messages.length).toBeLessThanOrEqual(windowSize);
    expect(messages[0].role).toBe('user');

    // Act (Step 2) — new Agent with truncated messages
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize,
        shouldTruncateResults: true,
      }),
    });

    // Act (Step 3) — Turn 1
    await chat(agent, 'What is 5 + 5? Just the number.');
    const after1 = agent.messages[agent.messages.length - 1];
    expect(after1.role).toBe('assistant');
    expect(textOf(after1)).toContain('10');

    // Act (Step 3 continued) — Turn 2
    await chat(agent, 'What is 6 + 7? Just the number.');
    const after2 = agent.messages[agent.messages.length - 1];
    expect(after2.role).toBe('assistant');
    expect(textOf(after2)).toContain('13');

    // Total messages must stay bounded even after multiple turns
    expect(agent.messages.length).toBeLessThanOrEqual(windowSize + 4);
    expect(agent.messages[0].role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Window size variation tests
// (These use applyWindowTruncation directly to test non-default sizes,
//  including odd numbers that cannot be set via CONVERSATION_WINDOW_SIZE
//  which requires an even integer ≥ 2.)
// ---------------------------------------------------------------------------

describe('applyWindowTruncation size variations → Agent new → conversation', () => {
  /**
   * windowSize = 41 (odd number)
   *
   * CONVERSATION_WINDOW_SIZE only accepts even numbers, but applyWindowTruncation
   * itself has no such constraint. When the window size is odd, the trim-point
   * algorithm may land on a valid cut point that leaves an odd number of messages.
   * The resulting first message could theoretically be 'assistant' if history ends
   * that way — but the SDK and Bedrock must still handle the request gracefully.
   */
  it('odd windowSize=41: applyWindowTruncation → Agent new + chat succeeds', async () => {
    // Arrange — 200 messages, truncate to 41
    const fullHistory = buildPlainHistory(100, 200);
    const windowSize = 41;
    const messages = applyWindowTruncation(fullHistory, windowSize);

    expect(messages.length).toBeLessThanOrEqual(windowSize);
    // The first message must not start with toolResultBlock
    const firstHasToolResult = messages[0]?.content.some(
      (b) => (b as { type: string }).type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);

    // Act — new Agent must succeed
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 42, // nearest even number ≥ windowSize for the manager
        shouldTruncateResults: true,
      }),
    });

    await chat(agent, 'What is 8 + 9? Just the number.');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('17');
  });

  /**
   * windowSize = 4 (very small window)
   *
   * Only the 4 most recent messages are retained. This is an extreme case
   * that verifies the agent can still start a conversation with minimal context.
   */
  it('small windowSize=4: applyWindowTruncation → Agent new + chat succeeds', async () => {
    // Arrange — 100 messages, truncate to 4
    const fullHistory = buildPlainHistory(50, 200);
    const windowSize = 4;
    const messages = applyWindowTruncation(fullHistory, windowSize);

    expect(messages.length).toBeLessThanOrEqual(windowSize);
    expect(messages[0].role).toBe('user');

    // Act
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize,
        shouldTruncateResults: true,
      }),
    });

    await chat(agent, 'What is 2 + 3? Just the number.');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('5');
    expect(agent.messages.length).toBeLessThanOrEqual(windowSize + 2);
  });

  /**
   * windowSize = 200 (equal to history length)
   *
   * When windowSize equals the number of stored messages, no truncation occurs.
   * The full history is passed to the Agent unchanged.
   */
  it('windowSize=200 equals history length: no truncation, Agent new + chat succeeds', async () => {
    // Arrange — exactly 200 messages, windowSize=200
    const fullHistory = buildPlainHistory(100, 100);
    expect(fullHistory).toHaveLength(200);
    const windowSize = 200;

    const messages = applyWindowTruncation(fullHistory, windowSize);

    // No truncation — same reference returned
    expect(messages).toBe(fullHistory);
    expect(messages).toHaveLength(200);

    // Act
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize,
        shouldTruncateResults: true,
      }),
    });

    await chat(agent, 'What is 4 + 5? Just the number.');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('9');
  });

  /**
   * windowSize = 500 (larger than history)
   *
   * When windowSize exceeds the stored message count, no truncation occurs.
   * All messages are passed through unchanged.
   */
  it('windowSize=500 larger than history: no truncation, Agent new + chat succeeds', async () => {
    // Arrange — 60 messages, windowSize=500 (far larger than history)
    const fullHistory = buildPlainHistory(30, 100);
    expect(fullHistory).toHaveLength(60);
    const windowSize = 500;

    const messages = applyWindowTruncation(fullHistory, windowSize);

    // No truncation — same reference returned
    expect(messages).toBe(fullHistory);
    expect(messages).toHaveLength(60);

    // Act
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 60, // use actual message count as manager window
        shouldTruncateResults: true,
      }),
    });

    await chat(agent, 'What is 7 + 8? Just the number.');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('15');
  });

  /**
   * Orphaned toolUse: history ends with toolUse, toolResult, toolUse (no paired toolResult)
   *
   * This is the "toolUse, toolResult, toolUse" pattern the user asked about.
   * The last toolUse has no paired toolResult — passing it to Bedrock causes ValidationException.
   * applyWindowTruncation must skip the orphaned toolUse and find a safe cut point.
   */
  it('orphaned final toolUse skipped — truncation finds safe cut point, Agent new + chat succeeds', async () => {
    // Build history:
    //   20 plain messages (10 pairs)
    //   + toolUse1 cycle (4 messages: user, assistant(toolUse), user(toolResult), assistant(done))
    //   + user(Q), assistant(toolUse2-ORPHAN)  ← no toolResult follows
    //
    // Total: 26 messages, last 2 form an orphaned toolUse pattern

    const dummyCalculator = tool({
      name: 'calculator',
      description: 'A simple calculator',
      inputSchema: z.object({ expression: z.string() }),
      callback: async (input: { expression: string }) => `result: ${input.expression}`,
    });

    const history: Message[] = [
      ...buildPlainHistory(10, 100), // 20 plain messages (indices 0-19)
      // toolUse1 cycle (indices 20-23)
      new Message({ role: 'user', content: [new TextBlock('Please calculate 3 + 4')] }),
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({ toolUseId: 'tu-1', name: 'calculator', input: { expression: '3+4' } }),
        ],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tu-1',
            content: [{ type: 'textBlock' as const, text: '7' }],
            status: 'success',
          }),
        ],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('The result is 7.')] }),
      // Orphaned toolUse2 (indices 24-25): user asks, agent starts toolUse but NO toolResult
      new Message({ role: 'user', content: [new TextBlock('Now calculate 5 + 6')] }),
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({
            toolUseId: 'tu-orphan',
            name: 'calculator',
            input: { expression: '5+6' },
          }),
        ],
      }),
      // ← No toolResult here! This is the "toolUse without pair" scenario.
    ];
    expect(history).toHaveLength(26);

    // Use a small explicit windowSize to force truncation near the orphaned toolUse
    // (CONVERSATION_WINDOW_SIZE default is 40, which is larger than 26 and would skip truncation)
    const smallWindow = 6;
    const messages = applyWindowTruncation(history, smallWindow);

    // The orphaned toolUse (index 25) must NOT be the first message
    const firstHasOrphanedToolUse =
      messages[0]?.content.some((b) => (b as { type: string }).type === 'toolUseBlock') &&
      messages[1] !== undefined &&
      !messages[1].content.some((b) => (b as { type: string }).type === 'toolResultBlock');
    expect(firstHasOrphanedToolUse).toBe(false);

    // The first message must never be a toolResultBlock
    const firstHasToolResult = messages[0]?.content.some(
      (b) => (b as { type: string }).type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);

    // Act — new Agent must succeed without ValidationException
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'You are a helpful assistant. Be very brief.',
      tools: [dummyCalculator],
      messages,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: smallWindow,
        shouldTruncateResults: true,
      }),
    });

    await chat(agent, 'What is 9 + 1? Just the number.');

    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('10');
  });
});
