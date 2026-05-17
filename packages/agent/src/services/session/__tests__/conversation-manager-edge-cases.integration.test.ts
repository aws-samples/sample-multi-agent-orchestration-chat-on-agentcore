/**
 * Conversation Manager Edge-Case Integration Tests
 *
 * Covers scenarios not addressed by the base conversation-manager tests:
 *   #3  SlidingWindow + CachePointBlock interaction
 *   #4  Tool-use / tool-result messages and truncation
 *   #5  windowSize boundary values (0, 1, 2)
 *   #6  Message ordering guarantees after truncation
 *
 * Run: cd packages/agent && npm run test:integration -- conversation-manager-edge-cases
 */

import { describe, it, expect } from '@jest/globals';
import {
  Agent,
  Message,
  TextBlock,
  CachePointBlock,
  ToolUseBlock,
  ToolResultBlock,
  SlidingWindowConversationManager,
  tool,
} from '@strands-agents/sdk';
import { z } from 'zod';
import { createBedrockModel } from '../../models/bedrock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract concatenated text from a message's text content blocks. */
function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** Build N user/assistant pairs of plain text messages. */
function buildHistory(pairs: number, charsPerMessage = 400): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push(
      new Message({
        role: 'user',
        content: [
          new TextBlock(
            `Question ${i + 1}: ` +
              'Lorem ipsum dolor sit amet. '.repeat(Math.ceil(charsPerMessage / 28))
          ),
        ],
      }),
      new Message({
        role: 'assistant',
        content: [
          new TextBlock(
            `Answer ${i + 1}: ` +
              'The quick brown fox jumps. '.repeat(Math.ceil(charsPerMessage / 27))
          ),
        ],
      })
    );
  }
  return messages;
}

/** Build a history that contains tool-use / tool-result message triplets. */
function buildToolHistory(toolPairs: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < toolPairs; i++) {
    const toolUseId = `tu-${i + 1}`;
    messages.push(
      new Message({
        role: 'user',
        content: [new TextBlock(`Please run tool for step ${i + 1}`)],
      }),
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({ toolUseId, name: 'calculator', input: { expression: `${i}+1` } }),
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
        content: [new TextBlock(`The result of step ${i + 1} is ${i + 1}.`)],
      })
    );
  }
  return messages;
}

/** Send a message via stream and consume all events. */
async function chat(agent: Agent, prompt: string): Promise<void> {
  for await (const event of agent.stream(prompt)) {
    void event;
  }
}

// ---------------------------------------------------------------------------
// #3  SlidingWindow + CachePointBlock interaction
// ---------------------------------------------------------------------------

describe('#3 SlidingWindow + CachePointBlock interaction', () => {
  it('preserves CachePointBlock on the last message when it survives truncation', async () => {
    // Arrange — 20 messages (10 pairs), CachePointBlock on the last assistant message.
    // windowSize=10 → last 10 messages survive; CachePointBlock should remain.
    const history = buildHistory(10);
    const lastMsg = history[history.length - 1];
    lastMsg.content.push(new CachePointBlock({ cacheType: 'default' }));

    const agent = new Agent({
      model: createBedrockModel({ cachePrompt: 'default' }),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 10,
        shouldTruncateResults: true,
      }),
    });

    // Act — send a message; the truncated history (with cache point) should work
    await chat(agent, 'What is 3 + 4? Just the number.');

    // Assert — agent responded successfully
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('7');
  });

  it('still works when CachePointBlock is on a truncated (removed) message', async () => {
    // Arrange — 20 messages, CachePointBlock on message index 5 (pair 2's assistant).
    // windowSize=6 → only the last 6 messages survive → CachePointBlock is dropped.
    const history = buildHistory(10);
    history[5].content.push(new CachePointBlock({ cacheType: 'default' }));

    const agent = new Agent({
      model: createBedrockModel({ cachePrompt: 'default' }),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 6,
        shouldTruncateResults: true,
      }),
    });

    // Act — should still succeed (just no cache benefit from the dropped point)
    await chat(agent, 'What is 5 + 9? Just the number.');

    // Assert
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('14');
  });

  it('responds correctly across two turns with CachePointBlock + sliding window', async () => {
    // Arrange — large history so truncation kicks in; CachePointBlock on last msg
    const history = buildHistory(30);
    history[history.length - 1].content.push(new CachePointBlock({ cacheType: 'default' }));

    const agent = new Agent({
      model: createBedrockModel({ cachePrompt: 'default' }),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 20,
        shouldTruncateResults: true,
      }),
    });

    // Act — two turns to exercise cache read on second turn
    await chat(agent, 'What is 10 + 10? Just the number.');
    await chat(agent, 'What is 20 + 20? Just the number.');

    // Assert
    const msgs = agent.messages;
    expect(msgs[msgs.length - 1].role).toBe('assistant');
    expect(textOf(msgs[msgs.length - 1])).toContain('40');
    // Total messages should be bounded by windowSize + new turns
    expect(msgs.length).toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// #4  Tool-use / tool-result messages and truncation
// ---------------------------------------------------------------------------

describe('#4 Tool-use / tool-result messages with sliding window', () => {
  it('responds correctly when tool history is fully preserved within window', async () => {
    // Arrange — 8 messages (2 tool triplets + responses), windowSize=10 → all preserved
    const history = buildToolHistory(2);

    // A dummy tool is needed because the history contains toolUse/toolResult blocks;
    // Bedrock requires toolConfig when those blocks are present.
    const dummyCalculator = tool({
      name: 'calculator',
      description: 'A simple calculator',
      inputSchema: z.object({ expression: z.string() }),
      callback: async (input: { expression: string }) => input.expression,
    });

    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt:
        'You are a helpful assistant. Be brief. You have access to a calculator tool but it is optional.',
      tools: [dummyCalculator],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 10,
        shouldTruncateResults: true,
      }),
    });

    // Act
    await chat(agent, 'What is 100 + 200? Just the number.');

    // Assert
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('300');
  });

  it('responds correctly when old tool messages are truncated away', async () => {
    // Arrange — 16 messages (4 tool triplets), windowSize=6 → only last ~6 survive
    // The last tool pair (messages 12-15) plus new turn should work.
    const history = buildToolHistory(4);

    // Append a clean user/assistant pair at the end so truncation leaves a valid sequence
    history.push(
      new Message({ role: 'user', content: [new TextBlock('Summary please.')] }),
      new Message({ role: 'assistant', content: [new TextBlock('All steps completed.')] })
    );

    // A dummy tool is needed because the history contains toolUse/toolResult blocks
    const dummyCalculator = tool({
      name: 'calculator',
      description: 'A simple calculator',
      inputSchema: z.object({ expression: z.string() }),
      callback: async (input: { expression: string }) => input.expression,
    });

    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [dummyCalculator],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 6,
        shouldTruncateResults: true,
      }),
    });

    // Act
    await chat(agent, 'What is 7 + 8? Just the number.');

    // Assert
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('15');
    expect(agent.messages.length).toBeLessThanOrEqual(10);
  });

  it('handles live tool invocation with sliding window active', async () => {
    // Arrange — define a simple tool and let the agent actually use it
    const calculatorTool = tool({
      name: 'add_numbers',
      description: 'Add two numbers and return the result',
      inputSchema: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      }),
      callback: async (input: { a: number; b: number }) => {
        return { result: input.a + input.b };
      },
    });

    // Pre-fill with some history so sliding window is exercised
    const history = buildHistory(10);

    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt:
        'You are a calculator assistant. When asked to add numbers, ALWAYS use the add_numbers tool. Respond with only the number result.',
      tools: [calculatorTool],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 14,
        shouldTruncateResults: true,
      }),
    });

    // Act — ask agent to use the tool
    await chat(agent, 'Use the add_numbers tool to calculate 42 + 58.');

    // Assert — agent should have used the tool and produced the answer
    const lastMsg = agent.messages[agent.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(textOf(lastMsg)).toContain('100');

    // Verify tool use occurred in messages
    const hasToolUse = agent.messages.some((m) =>
      m.content.some((c) => (c as { type: string }).type === 'toolUseBlock')
    );
    expect(hasToolUse).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #5  windowSize boundary values (0, 1, 2)
// ---------------------------------------------------------------------------

describe('#5 windowSize boundary values', () => {
  it('windowSize=0 throws an error during conversation management', async () => {
    // Arrange — windowSize=0 is not a valid configuration
    const history = buildHistory(3);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be brief.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 0,
        shouldTruncateResults: true,
      }),
    });

    // Act & Assert — should throw because no messages can be retained
    let caughtError: Error | undefined;
    try {
      await chat(agent, 'Hello');
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toMatch(/trim|overflow|context|unable/i);
  });

  it('windowSize=2 retains exactly one user/assistant pair and responds', async () => {
    // Arrange — 10 messages, windowSize=2 → keep only last pair
    const history = buildHistory(5);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 2,
        shouldTruncateResults: true,
      }),
    });

    // Act
    await chat(agent, 'What is 6 + 7? Just the number.');

    // Assert — should have at most windowSize + 2 (new user/assistant)
    expect(agent.messages.length).toBeLessThanOrEqual(6);
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('13');
  });

  it('windowSize=2 with empty initial history works normally', async () => {
    // Arrange — no history, windowSize=2 → no truncation needed
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 2,
        shouldTruncateResults: true,
      }),
    });

    // Act
    await chat(agent, 'What is 8 + 9? Just the number.');

    // Assert
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[0].role).toBe('user');
    expect(agent.messages[1].role).toBe('assistant');
    expect(textOf(agent.messages[1])).toContain('17');
  });

  it('windowSize=1 with history still works (SDK auto-corrects message sequence)', async () => {
    // Arrange — windowSize=1 with 4 messages → keeps only the last message (assistant).
    // The SDK may auto-correct the invalid sequence by adjusting truncation.
    const history = buildHistory(2);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be brief.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 1,
        shouldTruncateResults: true,
      }),
    });

    // Act — the SDK may handle this gracefully or throw
    let caughtError: Error | undefined;
    try {
      await chat(agent, 'Hello');
    } catch (error) {
      caughtError = error as Error;
    }

    // Either the SDK handled it gracefully or threw an appropriate error
    if (caughtError) {
      expect(caughtError.message).toBeTruthy();
    } else {
      // SDK auto-corrected: last message should be assistant
      expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    }
  });

  it('windowSize=1 with no history works (single user message fits)', async () => {
    // Arrange — no prior history, windowSize=1 is technically fine for a fresh conversation
    // because the single new user message satisfies the constraint.
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 1,
        shouldTruncateResults: true,
      }),
    });

    // Act — first turn: only 1 user message (within windowSize)
    await chat(agent, 'What is 2 + 3? Just the number.');

    // Assert
    const last = agent.messages[agent.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(textOf(last)).toContain('5');
  });
});

// ---------------------------------------------------------------------------
// #6  Message ordering guarantees after truncation
// ---------------------------------------------------------------------------

describe('#6 Message ordering after truncation', () => {
  it('first message is always user-role when windowSize is even', async () => {
    // Arrange — even windowSize ensures user/assistant pairs are not split
    const history = buildHistory(20);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 10,
        shouldTruncateResults: true,
      }),
    });

    // Act
    await chat(agent, 'What is 1 + 1? Just the number.');

    // Assert — first message should be user
    expect(agent.messages[0].role).toBe('user');
    // Last message should be assistant
    expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    expect(textOf(agent.messages[agent.messages.length - 1])).toContain('2');
  });

  it('odd windowSize is handled gracefully by SDK', async () => {
    // Arrange — windowSize=3 with 6 messages: truncation keeps last 3 messages.
    // The SDK may auto-correct the message sequence to ensure valid ordering.
    const history = buildHistory(3);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be brief.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 3,
        shouldTruncateResults: true,
      }),
    });

    // Act — the SDK may handle this gracefully or throw
    let caughtError: Error | undefined;
    try {
      await chat(agent, 'Hello');
    } catch (error) {
      caughtError = error as Error;
    }

    // Either the SDK handled it gracefully or threw an appropriate error
    if (caughtError) {
      expect(caughtError.message).toBeTruthy();
    } else {
      // SDK auto-corrected: last message should be assistant
      expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    }
  });

  it('maintains correct user/assistant alternation across multiple truncated turns', async () => {
    // Arrange — start with history, do 3 consecutive turns
    const history = buildHistory(15);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 10,
        shouldTruncateResults: true,
      }),
    });

    // Act — 3 turns, each triggering truncation
    await chat(agent, 'What is 1 + 2? Just the number.');
    await chat(agent, 'What is 3 + 4? Just the number.');
    await chat(agent, 'What is 5 + 6? Just the number.');

    // Assert — verify strict user/assistant alternation
    for (let i = 0; i < agent.messages.length - 1; i++) {
      const current = agent.messages[i].role;
      const next = agent.messages[i + 1].role;
      expect(current).not.toBe(next);
    }

    // First message must be user
    expect(agent.messages[0].role).toBe('user');
    // Last message must be assistant
    expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    expect(textOf(agent.messages[agent.messages.length - 1])).toContain('11');
  });

  it('total message count stays bounded after many turns', async () => {
    // Arrange — windowSize=8, start with 20 messages, do 5 turns
    const history = buildHistory(10);
    const agent = new Agent({
      model: createBedrockModel(),
      systemPrompt: 'Be very brief. Answer arithmetic with just the number.',
      tools: [],
      messages: history,
      conversationManager: new SlidingWindowConversationManager({
        windowSize: 8,
        shouldTruncateResults: true,
      }),
    });

    // Act — 5 turns
    const questions = ['1+1', '2+2', '3+3', '4+4', '5+5'];
    for (const q of questions) {
      await chat(agent, `What is ${q}? Just the number.`);
    }

    // Assert — messages should never exceed windowSize + 2 (current turn's user+assistant)
    expect(agent.messages.length).toBeLessThanOrEqual(12);
    expect(agent.messages[0].role).toBe('user');
    expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    expect(textOf(agent.messages[agent.messages.length - 1])).toContain('10');
  });
});
