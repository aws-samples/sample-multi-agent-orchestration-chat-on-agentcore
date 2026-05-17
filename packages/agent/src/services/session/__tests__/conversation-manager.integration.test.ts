/**
 * Conversation Manager Integration Tests
 *
 * Verifies that SlidingWindowConversationManager prevents token overflow errors
 * by automatically trimming conversation history when it exceeds the window size.
 *
 * Run: cd packages/agent && npm run test:integration -- conversation-manager
 */

import { describe, it, expect } from '@jest/globals';
import {
  Agent,
  Message,
  TextBlock,
  SlidingWindowConversationManager,
  NullConversationManager,
} from '@strands-agents/sdk';
import { createBedrockModel } from '../../models/bedrock.js';

/**
 * Build a conversation history of user/assistant pairs.
 * Each message is padded with filler text to consume a predictable number of tokens.
 */
function buildHistory(pairs: number, charsPerMessage: number = 800): Message[] {
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

describe('SlidingWindowConversationManager', () => {
  describe('with large conversation history', () => {
    it('trims messages and responds without token overflow', async () => {
      // Arrange — 200 messages (~40K tokens), windowSize=40
      const history = buildHistory(100, 800);
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: 'You are a helpful assistant. Respond briefly.',
        tools: [],
        messages: history,
        conversationManager: new SlidingWindowConversationManager({
          windowSize: 40,
          shouldTruncateResults: true,
        }),
      });

      // Act
      for await (const event of agent.stream('What is 2 + 2? Answer in one word.')) {
        void event;
      }

      // Assert
      const lastMessage = agent.messages[agent.messages.length - 1];
      expect(lastMessage.role).toBe('assistant');
      expect(agent.messages.length).toBeLessThanOrEqual(50);
    });
  });

  describe('with NullConversationManager (no trimming)', () => {
    it('throws token overflow error when history exceeds model limit', async () => {
      // Arrange — 1000 messages (~500K tokens), well over the 200K limit
      const history = buildHistory(500, 2000);
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
        messages: history,
        conversationManager: new NullConversationManager(),
      });

      // Act & Assert — expect an error from Bedrock
      let caughtError: Error | undefined;
      try {
        for await (const event of agent.stream('What is 2 + 2?')) {
          void event;
        }
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toMatch(
        /prompt is too long|ValidationException|too many tokens|token/i
      );
    });
  });

  describe('windowSize configuration', () => {
    it('limits messages to the configured windowSize', async () => {
      // Arrange — 40 messages with a small windowSize=10
      const history = buildHistory(20, 400);
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: 'You are a helpful assistant. Respond briefly.',
        tools: [],
        messages: history,
        conversationManager: new SlidingWindowConversationManager({
          windowSize: 10,
          shouldTruncateResults: true,
        }),
      });

      // Act
      for await (const event of agent.stream('Say hello.')) {
        void event;
      }

      // Assert — windowSize=10 + new user/assistant ≈ 12 max
      expect(agent.messages.length).toBeLessThanOrEqual(15);
      expect(agent.messages.length).toBeGreaterThan(0);
      expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    });
  });
});
