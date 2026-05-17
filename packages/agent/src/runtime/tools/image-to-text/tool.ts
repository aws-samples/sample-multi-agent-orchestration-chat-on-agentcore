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
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'fs/promises';
import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import { createUserScopedS3Client } from '../../../libs/utils/scoped-credentials.js';
import type { ImageToTextResult, ImageFormat, ImageSource } from './types.js';
import { imageToTextDefinition } from '@moca/tool-definitions';

// Create Bedrock Runtime client
const bedrockClient = new BedrockRuntimeClient({ region: config.BEDROCK_REGION });

/**
 * Get an S3 client scoped to the current user, or fall back to default.
 */
async function getS3Client(userId: string): Promise<S3Client> {
  if (config.IDENTITY_POOL_ID) {
    return createUserScopedS3Client(userId);
  }
  logger.warn(
    `[IMAGE_TO_TEXT] IDENTITY_POOL_ID is not set. ` +
      `Using execution role for user=${userId} — ` +
      `ensure IAM policy restricts access to the users/${userId}/* prefix.`
  );
  return new S3Client({ region: config.AWS_REGION });
}

/**
 * Parse S3 URI to bucket and key
 */
function parseS3Uri(s3Uri: string): { bucket: string; key: string } | null {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Detect image format from buffer
 */
function detectImageFormat(buffer: Buffer): ImageFormat | null {
  // Check magic bytes
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'gif';
  }
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }
  return null;
}

/**
 * Fetch image from S3
 */
async function fetchImageFromS3(s3Uri: string, userId: string): Promise<ImageSource> {
  const parsed = parseS3Uri(s3Uri);
  if (!parsed) {
    throw new Error(`Invalid S3 URI format: ${s3Uri}`);
  }

  logger.debug(`[IMAGE_TO_TEXT] Fetching image from S3: ${s3Uri}`);

  try {
    const s3Client = await getS3Client(userId);
    const command = new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Detect format
    const format = detectImageFormat(buffer);
    if (!format) {
      throw new Error('Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP');
    }

    logger.debug(
      `[IMAGE_TO_TEXT] Image fetched successfully: ${format.toUpperCase()}, ${buffer.length} bytes`
    );

    return {
      type: 's3',
      data: buffer,
      format,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[IMAGE_TO_TEXT] Failed to fetch image from S3: ${errorMessage}`);
    throw new Error(`S3 fetch failed: ${errorMessage}`, { cause: error });
  }
}

/**
 * Process local file image
 */
async function processLocalFile(filePath: string): Promise<ImageSource> {
  logger.debug(`[IMAGE_TO_TEXT] Processing local file: ${filePath}`);

  try {
    // Read file
    const buffer = await readFile(filePath);

    // Detect format
    const format = detectImageFormat(buffer);
    if (!format) {
      throw new Error('Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP');
    }

    logger.debug(
      `[IMAGE_TO_TEXT] Local file processed: ${format.toUpperCase()}, ${buffer.length} bytes`
    );

    return {
      type: 'local',
      data: buffer,
      format,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[IMAGE_TO_TEXT] Failed to process local file: ${errorMessage}`);
    throw new Error(`Local file processing failed: ${errorMessage}`, { cause: error });
  }
}

/**
 * Get image source from path
 */
async function getImageSource(imagePath: string, userId: string): Promise<ImageSource> {
  if (imagePath.startsWith('s3://')) {
    return fetchImageFromS3(imagePath, userId);
  } else {
    return processLocalFile(imagePath);
  }
}

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
      const imageSource = await getImageSource(imagePath, context.userId);

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
