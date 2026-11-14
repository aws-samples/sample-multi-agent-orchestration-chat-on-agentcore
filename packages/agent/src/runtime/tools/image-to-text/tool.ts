/**
 * Image to Text Tool - Convert images to text descriptions using Bedrock Converse API
 */

import { tool } from '@strands-agents/sdk';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ImageBlock,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import { loadImageSource, type ImageSource } from '../../../libs/utils/image-source.js';
import type { ImageToTextResult } from './types.js';
import { imageToTextDefinition } from '@moca/tool-definitions';

// Create Bedrock Runtime client
const bedrockClient = new BedrockRuntimeClient({ region: config.BEDROCK_REGION });

/**
 * Analyze image using Bedrock Converse API
 */
async function analyzeImage(
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

/**
 * Format analysis results
 */
function formatResults(result: ImageToTextResult): string {
  let output = '🖼️ Image Analysis Result\n\n';

  if (result.success) {
    output += `✅ Analysis successful\n`;
    output += `Model: ${result.modelId}\n`;
    output += `Image: ${result.imagePath}\n\n`;
    output += `Description:\n${result.description}`;
  } else {
    output += `❌ Analysis failed\n`;
    output += `Model: ${result.modelId}\n`;
    output += `Image: ${result.imagePath}\n`;
    output += `Error: ${result.error}`;
  }

  return output;
}

/**
 * Image to Text Tool
 */
export const imageToTextTool = tool({
  name: imageToTextDefinition.name,
  description: imageToTextDefinition.description,
  inputSchema: imageToTextDefinition.zodSchema,
  callback: async (input) => {
    const { imagePath, prompt, modelId } = input;

    logger.info(
      `[IMAGE_TO_TEXT] Image analysis started: path="${imagePath.substring(0, 50)}...", model="${modelId}"`
    );

    // Get user context
    const context = getCurrentContext();
    if (!context?.userId) {
      logger.error('[IMAGE_TO_TEXT] Failed to get user ID from context');
      return `❌ Error: User authentication information not found. Please log in again.`;
    }

    try {
      // Get image source (with user-scoped S3 access)
      const imageSource = await loadImageSource(imagePath, context.userId);

      // Analyze image
      const description = await analyzeImage(imageSource, prompt, modelId);

      // Prepare result
      const result: ImageToTextResult = {
        success: true,
        description,
        modelId,
        imagePath,
      };

      return formatResults(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[IMAGE_TO_TEXT] Image analysis error: ${errorMessage}`);

      const result: ImageToTextResult = {
        success: false,
        description: '',
        modelId,
        imagePath,
        error: errorMessage,
      };

      return (
        formatResults(result) +
        '\n\nTroubleshooting:\n' +
        '1. Verify the image path is correct (S3 URI or local file path)\n' +
        '2. Verify AWS credentials have S3 and Bedrock permissions\n' +
        '3. Verify the image format is supported (JPEG, PNG, GIF, WebP)\n' +
        '4. Verify the model ID is correct and available in the region\n' +
        '5. For local files, verify the file exists and has read permissions'
      );
    }
  },
});
