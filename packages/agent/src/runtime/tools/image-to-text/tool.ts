/**
 * Image to Text Tool - Convert images to text descriptions using Bedrock Converse API
 */

import { imageToTextDefinition } from '@moca/tool-definitions';
import { logger } from '../../../libs/logger/index.js';
import { defineTool, requireUserId } from '../_shared/index.js';
import { getImageSource } from './image-source.js';
import { analyzeImage } from './bedrock.js';
import { formatResults } from './format.js';
import type { ImageToTextResult } from './types.js';

/**
 * Image to Text Tool
 *
 * Resolves the image (S3 URI or local file), analyzes it with a vision model,
 * and returns a formatted description. The inner `try/catch` returns the rich
 * failure string (formatted result + troubleshooting steps); `defineTool` is
 * only a backstop for anything that escapes it. `requireUserId()` surfaces the
 * login-prompt guidance when the request is unauthenticated.
 */
export const imageToTextTool = defineTool(imageToTextDefinition, async (input) => {
  const { imagePath, prompt, modelId } = input;

  logger.info(
    `[IMAGE_TO_TEXT] Image analysis started: path="${imagePath.substring(0, 50)}...", model="${modelId}"`
  );

  // Get authenticated user (S3 access is scoped to this user)
  const userId = requireUserId();

  try {
    // Get image source (with user-scoped S3 access)
    const imageSource = await getImageSource(imagePath, userId);

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
});
