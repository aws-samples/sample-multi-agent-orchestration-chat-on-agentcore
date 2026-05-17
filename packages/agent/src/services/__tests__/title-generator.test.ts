/**
 * Unit tests for TitleGenerator
 * Tests parseResponse and buildPrompt private methods directly,
 * and generateTitle through a mocked Bedrock client.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../config/index.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  config: {},
}));

const { TitleGenerator } = await import('../title-generator.js');

// Helper to build a valid Bedrock Converse response
function makeBedrockResponse(text: string) {
  return {
    output: {
      message: {
        content: [{ text }],
      },
    },
  };
}

describe('TitleGenerator', () => {
  let generator: InstanceType<typeof TitleGenerator>;

  let mockSend: any;

  beforeEach(() => {
    jest.clearAllMocks();
    generator = new TitleGenerator();
    mockSend = jest.fn();
    // Replace the private client with a mock to intercept send() calls
    (generator as any).client = { send: mockSend };
  });

  // ──────────────────────────────────────────────
  // parseResponse (via private method access)
  // ──────────────────────────────────────────────

  describe('parseResponse', () => {
    const parse = (response: unknown) =>
      (generator as unknown as { parseResponse: (r: unknown) => string }).parseResponse(response);

    it('extracts title from a normal text response', () => {
      const response = makeBedrockResponse('My Conversation Title');
      expect(parse(response)).toBe('My Conversation Title');
    });

    it('strips surrounding double quotes', () => {
      const response = makeBedrockResponse('"My Title"');
      expect(parse(response)).toBe('My Title');
    });

    it('strips surrounding single quotes', () => {
      const response = makeBedrockResponse("'My Title'");
      expect(parse(response)).toBe('My Title');
    });

    it('strips surrounding Japanese quotes', () => {
      const response = makeBedrockResponse('\u300C\u30BF\u30A4\u30C8\u30EB\u300D');
      expect(parse(response)).toBe('\u30BF\u30A4\u30C8\u30EB');
    });

    it('strips "Title: " prefix', () => {
      const response = makeBedrockResponse('Title: My Title');
      expect(parse(response)).toBe('My Title');
    });

    it('strips case-insensitive "TITLE: " prefix', () => {
      const response = makeBedrockResponse('TITLE: My Title');
      expect(parse(response)).toBe('My Title');
    });

    it('strips Japanese title prefix', () => {
      const response = makeBedrockResponse('\u30BF\u30A4\u30C8\u30EB: My Title');
      expect(parse(response)).toBe('My Title');
    });

    it('truncates title longer than 50 characters to 47 chars + "..."', () => {
      const longTitle = 'a'.repeat(51);
      const response = makeBedrockResponse(longTitle);
      const result = parse(response);
      expect(result).toBe('a'.repeat(47) + '...');
      expect(result).toHaveLength(50);
    });

    it('does not truncate title of exactly 50 characters', () => {
      const title50 = 'b'.repeat(50);
      const response = makeBedrockResponse(title50);
      expect(parse(response)).toBe(title50);
    });

    it('throws "Empty response from Bedrock" when content array is empty', () => {
      const response = { output: { message: { content: [] } } };
      expect(() => parse(response)).toThrow('Empty response from Bedrock');
    });

    it('throws "No text content in response" when no text block exists', () => {
      const response = { output: { message: { content: [{}] } } };
      expect(() => parse(response)).toThrow('No text content in response');
    });

    it('strips both quotes AND prefix together', () => {
      const response = makeBedrockResponse('"Title: My Title"');
      expect(parse(response)).toBe('My Title');
    });

    it('trims leading and trailing whitespace', () => {
      const response = makeBedrockResponse('  My Title  ');
      expect(parse(response)).toBe('My Title');
    });
  });

  // ──────────────────────────────────────────────
  // buildPrompt (via private method access)
  // ──────────────────────────────────────────────

  describe('buildPrompt', () => {
    const build = (userMessage: string, assistantMessage?: string) =>
      (
        generator as unknown as {
          buildPrompt: (u: string, a?: string) => string;
        }
      ).buildPrompt(userMessage, assistantMessage);

    it('includes the user message in the prompt', () => {
      const prompt = build('Hello, how are you?');
      expect(prompt).toContain('User: Hello, how are you?');
    });

    it('does NOT include "Assistant:" section when assistantMessage is absent', () => {
      const prompt = build('Hello');
      expect(prompt).not.toContain('Assistant:');
    });

    it('includes the assistant message when provided', () => {
      const prompt = build('Hello', 'I am doing well!');
      expect(prompt).toContain('Assistant: I am doing well!');
    });

    it('truncates user message longer than 500 characters', () => {
      const longMessage = 'x'.repeat(600);
      const prompt = build(longMessage);
      expect(prompt).toContain('User: ' + 'x'.repeat(500));
      expect(prompt).not.toContain('x'.repeat(501));
    });

    it('truncates assistant message longer than 500 characters', () => {
      const longAssistant = 'y'.repeat(600);
      const prompt = build('Hi', longAssistant);
      expect(prompt).toContain('Assistant: ' + 'y'.repeat(500));
      expect(prompt).not.toContain('y'.repeat(501));
    });

    it('ends with "## Title:" section', () => {
      const prompt = build('Some message');
      expect(prompt).toMatch(/##\s*Title:/);
    });
  });

  // ──────────────────────────────────────────────
  // generateTitle (integration with mocked Bedrock)
  // ──────────────────────────────────────────────

  describe('generateTitle', () => {
    it('returns the generated title from Bedrock response', async () => {
      mockSend.mockResolvedValueOnce(makeBedrockResponse('Code Review Workflow'));

      const title = await generator.generateTitle('Review my pull request');
      expect(title).toBe('Code Review Workflow');
    });

    it('strips quotes from the Bedrock response in generateTitle', async () => {
      mockSend.mockResolvedValueOnce(makeBedrockResponse('"Code Review Workflow"'));

      const title = await generator.generateTitle('Review my pull request');
      expect(title).toBe('Code Review Workflow');
    });

    it('passes both user and assistant messages to Bedrock when provided', async () => {
      mockSend.mockResolvedValueOnce(makeBedrockResponse('Database Migration Help'));

      const title = await generator.generateTitle(
        'Help me migrate my database',
        'Sure, here is how to migrate...'
      );

      expect(title).toBe('Database Migration Help');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('throws when Bedrock returns an empty response', async () => {
      mockSend.mockResolvedValueOnce({ output: { message: { content: [] } } });

      await expect(generator.generateTitle('Hello')).rejects.toThrow('Empty response from Bedrock');
    });

    it('propagates Bedrock client errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Bedrock service unavailable'));

      await expect(generator.generateTitle('Hello')).rejects.toThrow('Bedrock service unavailable');
    });
  });
});
