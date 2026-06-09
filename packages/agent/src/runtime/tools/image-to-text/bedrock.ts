/**
 * Bedrock Converse integration for the image_to_text tool.
 *
 * Owns the module-level `BedrockRuntimeClient` and `analyzeImage`, which sends
 * the image plus prompt to a vision model and returns the text description.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ImageBlock,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import type { ImageSource } from './types.js';

// Create Bedrock Runtime client
const bedrockClient = new BedrockRuntimeClient({ region: config.BEDROCK_REGION });

/**
 * Analyze an image with the given prompt using the Bedrock Converse API.
 *
 * @returns the model's text description of the image.
 */
export async function analyzeImage(
  imageSource: ImageSource,
  prompt: string,
  modelId: string
): Promise<string> {
  try {
    logger.debug(`[IMAGE_TO_TEXT] Analyzing image with model: ${modelId}`);

    // Build image block
    const imageBlock: ImageBlock = {
      format: imageSource.format,
      source: {
        bytes: imageSource.data,
      },
    };

    // Build content blocks
    const contentBlocks: ContentBlock[] = [{ image: imageBlock }, { text: prompt }];

    // Create Converse command
    const command = new ConverseCommand({
      modelId,
      messages: [
        {
          role: 'user',
          content: contentBlocks,
        },
      ],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.1,
      },
    });

    const startTime = Date.now();
    const response = await bedrockClient.send(command);
    const duration = Date.now() - startTime;

    // Extract text from response
    const outputContent = response.output?.message?.content;
    if (!outputContent || outputContent.length === 0) {
      throw new Error('Empty response from model');
    }

    const textBlock = outputContent.find((block) => 'text' in block);
    if (!textBlock || !('text' in textBlock) || !textBlock.text) {
      throw new Error('No text content in response');
    }

    const description: string = textBlock.text;

    logger.info(
      `[IMAGE_TO_TEXT] Analysis completed in ${duration}ms, response length: ${description.length} chars`
    );

    return description;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[IMAGE_TO_TEXT] Image analysis failed: ${errorMessage}`);
    throw new Error(`Image analysis failed: ${errorMessage}`, { cause: error });
  }
}
