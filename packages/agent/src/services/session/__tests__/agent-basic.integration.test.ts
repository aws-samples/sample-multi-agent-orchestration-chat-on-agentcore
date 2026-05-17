/**
 * Agent Basic Integration Tests
 *
 * Verifies core Agent functionality with actual Bedrock API calls:
 * system prompt adherence, streaming, prompt caching, multi-turn memory.
 *
 * Run: cd packages/agent && npm run test:integration -- agent-basic
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk';
import { createBedrockModel } from '../../models/bedrock.js';

/** Extract text from a message's content blocks (inline to keep tests self-contained). */
function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** Send a message via stream and consume all events. */
async function chat(agent: Agent, prompt: string): Promise<void> {
  for await (const event of agent.stream(prompt)) {
    void event;
  }
}

describe('Agent Basic', () => {
  describe('system prompt', () => {
    it('follows instructions to respond with PONG', async () => {
      // Arrange
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt:
          'Always respond with exactly the word "PONG" when the user says "PING". No other text.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act
      for await (const event of agent.stream('PING')) {
        void event;
      }

      // Assert
      expect(textOf(agent.messages[agent.messages.length - 1]).toUpperCase()).toContain('PONG');
    });
  });

  describe('streaming', () => {
    it('delivers events and builds user + assistant messages', async () => {
      // Arrange
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: 'Be very brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act
      const events: unknown[] = [];
      for await (const event of agent.stream('What is the capital of Japan? One word.')) {
        events.push(event);
      }

      // Assert — received stream events
      expect(events.length).toBeGreaterThan(0);
      // Assert — 2 messages: user, assistant
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages[0].role).toBe('user');
      expect(agent.messages[1].role).toBe('assistant');
      // Assert — correct answer
      expect(textOf(agent.messages[1]).toLowerCase()).toContain('tokyo');
    });
  });

  describe('prompt caching', () => {
    it('responds correctly across two turns with caching enabled', async () => {
      // Arrange
      const agent = new Agent({
        model: createBedrockModel({ cachePrompt: 'default', cacheTools: 'default' }),
        systemPrompt: 'Be brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act — turn 1
      for await (const event of agent.stream('What is 3 + 5? Just the number.')) {
        void event;
      }
      // Act — turn 2 (benefits from cached system prompt)
      for await (const event of agent.stream('What is 10 + 20? Just the number.')) {
        void event;
      }

      // Assert
      expect(agent.messages).toHaveLength(4); // user, assistant, user, assistant
      expect(textOf(agent.messages[1])).toContain('8');
      expect(textOf(agent.messages[3])).toContain('30');
    });

    it('handles 5 consecutive turns with a long system prompt and caching', async () => {
      // Arrange — long system prompt (~6000+ chars) to exercise prompt caching
      const paragraph =
        'You are an expert financial analyst assistant specializing in global markets. ' +
        'You analyze stock markets, bonds, derivatives, commodities, and complex financial instruments. ' +
        'You provide detailed analysis with precise numbers, percentages, and statistical measures. ' +
        'Always respond in a structured format. Use professional financial terminology throughout. ' +
        'When discussing risk, categorize it as Very Low, Low, Medium, High, or Critical. ' +
        'Always include relevant market data points and historical context for comparison. ' +
        'Format all currency values with appropriate symbols and two decimal places. ' +
        'Include year-over-year and quarter-over-quarter comparisons when available. ' +
        'Provide both bull case and bear case scenarios for any investment thesis discussed. ';
      const longSystemPrompt =
        paragraph.repeat(8) +
        'However, when asked a simple arithmetic question, respond with only the number.';

      const agent = new Agent({
        model: createBedrockModel({ cachePrompt: 'default' }),
        systemPrompt: longSystemPrompt,
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act — 5 consecutive turns
      const questions = ['1+1', '2+3', '4+6', '7+8', '10+20'];
      const expectedAnswers = ['2', '5', '10', '15', '30'];

      for (const q of questions) {
        await chat(agent, `What is ${q}? Just the number.`);
      }

      // Assert — all 5 turns produced correct answers (10 messages total)
      expect(agent.messages).toHaveLength(10);
      for (let i = 0; i < expectedAnswers.length; i++) {
        const answer = textOf(agent.messages[i * 2 + 1]);
        expect(answer).toContain(expectedAnswers[i]);
      }
    });

    it('works correctly without caching enabled', async () => {
      // Arrange — create a model explicitly without cache options
      const { BedrockModel } = await import('@strands-agents/sdk');
      const noCacheModel = new BedrockModel({
        region: process.env.BEDROCK_REGION || 'us-east-1',
        modelId: process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
        clientConfig: { retryMode: 'adaptive' as const, maxAttempts: 5 },
      });

      const agent = new Agent({
        model: noCacheModel,
        systemPrompt: 'Be brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act
      await chat(agent, 'What is 7 + 8? Just the number.');

      // Assert — responds correctly even without caching
      expect(agent.messages).toHaveLength(2);
      expect(textOf(agent.messages[1])).toContain('15');
    });

    it('rejects whitespace-only prompt with a validation error', async () => {
      // Arrange
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: 'Be brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act & Assert — Bedrock rejects whitespace-only text content
      let caughtError: Error | undefined;
      try {
        for await (const event of agent.stream(' ')) {
          void event;
        }
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toMatch(/non-whitespace|ValidationException/i);
    });
  });

  describe('multi-turn conversation', () => {
    it('remembers context from previous turns', async () => {
      // Arrange
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: 'Be very brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Act — establish context, then ask about it
      for await (const event of agent.stream('My name is Alice.')) {
        void event;
      }
      for await (const event of agent.stream('What is my name?')) {
        void event;
      }

      // Assert
      expect(agent.messages).toHaveLength(4);
      expect(textOf(agent.messages[3]).toLowerCase()).toContain('alice');
    });
  });
});
