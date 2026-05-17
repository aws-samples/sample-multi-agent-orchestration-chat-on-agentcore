/**
 * Session Title Generator Service
 * Generates concise session titles using LLM
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('TitleGenerator');
/**
 * Default model for title generation (lightweight, fast)
 */
const DEFAULT_MODEL_ID = 'global.amazon.nova-2-lite-v1:0';

/**
 * Title Generator using Bedrock LLM
 */
export class TitleGenerator {
  private client: BedrockRuntimeClient;
  private modelId: string;

  constructor(modelId?: string, region?: string) {
    this.client = new BedrockRuntimeClient({
      region: region || config.AWS_REGION,
    });
    this.modelId = modelId || DEFAULT_MODEL_ID;
  }

  /**
   * Generate a session title from conversation content
   * @param userMessage First user message
   * @param assistantMessage First assistant response (optional)
   * @returns Generated title (15-30 characters)
   */
  async generateTitle(userMessage: string, assistantMessage?: string): Promise<string> {
    try {
      const prompt = this.buildPrompt(userMessage, assistantMessage);

      log.debug(
        {
          userMessageLength: userMessage.length,
          assistantMessageLength: assistantMessage?.length || 0,
        },
        'Generating title with prompt length:'
      );

      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages: [
            {
              role: 'user',
              content: [{ text: prompt }],
            },
          ],
          inferenceConfig: {
            maxTokens: 100,
          },
        })
      );

      const title = this.parseResponse(response);

      log.info({ title }, 'Generated title:');

      return title;
    } catch (error) {
      log.error({ error }, 'Failed to generate title:');
      throw error;
    }
  }

  /**
   * Build the prompt for title generation
   */
  private buildPrompt(userMessage: string, assistantMessage?: string): string {
    // Truncate messages to limit token usage
    const truncatedUserMessage = userMessage.substring(0, 500);
    const truncatedAssistantMessage = assistantMessage?.substring(0, 500) || '';

    return `Generate a concise session title from the following conversation.

## Requirements
- 3 to 8 words (approximately 15-40 characters)
- Capture the main topic or intent of the conversation
- Use the same language as the user's message
- Output ONLY the title (no explanations, quotes, or punctuation)
- Avoid generic phrases like "Question about...", "Help with...", "Discussion of..."

## Conversation
User: ${truncatedUserMessage}
${truncatedAssistantMessage ? `Assistant: ${truncatedAssistantMessage}` : ''}

## Title:`;
  }

  /**
   * Parse the LLM response and extract the title
   */
  private parseResponse(response: {
    output?: { message?: { content?: Array<{ text?: string }> } };
  }): string {
    if (!response.output?.message?.content || response.output.message.content.length === 0) {
      throw new Error('Empty response from Bedrock');
    }

    const content = response.output.message.content;

    // Extract text from Converse API response format
    const textBlock = content.find((block) => block.text);
    if (!textBlock || !textBlock.text) {
      throw new Error('No text content in response');
    }

    // Clean up the title
    let title = textBlock.text.trim();

    // Remove quotes if present (supports various quote styles)
    title = title.replace(/^["'「」『』""'']+|["'「」『』""'']+$/g, '');

    // Remove common prefixes in multiple languages
    title = title.replace(/^(Title[:：]\s*|タイトル[:：]\s*)/i, '');

    // Truncate if too long
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title;
  }
}

// Singleton instance
let titleGeneratorInstance: TitleGenerator | null = null;

/**
 * Get or create TitleGenerator singleton
 */
export function getTitleGenerator(): TitleGenerator {
  if (!titleGeneratorInstance) {
    titleGeneratorInstance = new TitleGenerator();
  }
  return titleGeneratorInstance;
}
