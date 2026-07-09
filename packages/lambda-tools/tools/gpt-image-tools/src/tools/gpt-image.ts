/**
 * OpenAI gpt-image tool implementation (Lambda)
 *
 * Generates images using OpenAI's Images API (gpt-image family) and saves them
 * to the caller's S3 storage, returning S3 paths. User context (identityId,
 * storagePath) is injected by the Gateway Interceptor into the `_context` field
 * of the tool input — the same mechanism nova-canvas relies on for per-user
 * isolation.
 */

import {
  ToolInput,
  ToolResult,
  Tool,
  ToolValidationError,
  logger,
} from '@moca/lambda-tools-shared';
import { callOpenAiImageApi } from './gpt-image-common.js';
import { saveImageToS3 } from './s3-io.js';
import {
  DEFAULT_MODEL,
  MAX_IMAGES,
  VALID_SIZES,
  VALID_QUALITIES,
  type UserContext,
} from './constants.js';

const TOOL_NAME = 'gpt_image';

interface GptImageInput extends ToolInput {
  prompt?: string;
  size?: string;
  quality?: string;
  numberOfImages?: number;
  outputPath?: string;
  _context?: UserContext;
}

function generateFilename(index: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `gpt-image-${timestamp}-${index + 1}.png`;
}

async function handleGptImage(input: ToolInput): Promise<ToolResult> {
  const gptInput = input as GptImageInput;

  // Validate required fields
  if (!gptInput.prompt) {
    throw new ToolValidationError("'prompt' parameter is required", TOOL_NAME, 'prompt');
  }

  // Extract user context (injected by Gateway Interceptor)
  const userContext = gptInput._context;
  if (!userContext?.identityId) {
    throw new ToolValidationError(
      'identityId not found in user context. Ensure the Gateway Interceptor is configured with IDENTITY_POOL_ID.',
      TOOL_NAME,
      '_context'
    );
  }

  const { identityId, storagePath: rawStoragePath } = userContext;
  const storagePath = rawStoragePath || '/';

  // Apply defaults and validate
  const size = gptInput.size ?? 'auto';
  const quality = gptInput.quality ?? 'auto';
  const numberOfImages = Math.min(Math.max(gptInput.numberOfImages ?? 1, 1), MAX_IMAGES);

  if (!VALID_SIZES.includes(size)) {
    throw new ToolValidationError(
      `Invalid size: ${size}. Must be one of: ${VALID_SIZES.join(', ')}`,
      TOOL_NAME,
      'size'
    );
  }

  if (!VALID_QUALITIES.includes(quality)) {
    throw new ToolValidationError(
      `Invalid quality: ${quality}. Must be one of: ${VALID_QUALITIES.join(', ')}`,
      TOOL_NAME,
      'quality'
    );
  }

  logger.info('GPT_IMAGE_START', {
    promptLength: gptInput.prompt.length,
    size,
    quality,
    numberOfImages,
    identityId,
  });

  // Invoke OpenAI Images API
  const startTime = Date.now();
  const apiResponse = await callOpenAiImageApi({
    model: DEFAULT_MODEL,
    prompt: gptInput.prompt,
    n: numberOfImages,
    size,
    quality,
  });
  const duration = Date.now() - startTime;

  const images = apiResponse.data ?? [];
  logger.info('GPT_IMAGE_COMPLETE', { imageCount: images.length, durationMs: duration });

  // Save images to S3. gpt-image returns base64 (b64_json); skip any datum that
  // lacks it rather than writing an empty object.
  const s3Paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const b64 = images[i].b64_json;
    if (!b64) {
      logger.warn(`Image ${i + 1} has no b64_json payload; skipping`);
      continue;
    }

    const filename =
      gptInput.outputPath && images.length === 1
        ? gptInput.outputPath
        : gptInput.outputPath
          ? `${gptInput.outputPath}-${i + 1}.png`
          : generateFilename(i);

    try {
      const s3Path = await saveImageToS3(b64, storagePath, filename, identityId, 'gpt-image');
      if (s3Path) s3Paths.push(s3Path);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`Failed to save image ${i + 1} to S3: ${msg}`);
    }
  }

  // Build result (no base64 data — only S3 paths to avoid Lambda response size limit)
  const result: ToolResult = {
    success: true,
    prompt: gptInput.prompt,
    configuration: { model: DEFAULT_MODEL, size, quality, numberOfImages },
    imageCount: images.length,
    s3Paths,
    durationMs: duration,
    message: `Successfully generated ${images.length} image(s) in ${duration}ms.${
      s3Paths.length > 0 ? ` Saved to: ${s3Paths.join(', ')}` : ''
    }`,
  };

  return result;
}

export const gptImageTool: Tool = {
  name: TOOL_NAME,
  handler: handleGptImage,
  description:
    'Generate images using OpenAI gpt-image. Converts a text prompt into high-quality images and ' +
    'saves them to user S3 storage, returning S3 paths. Structure prompts as scene -> subject -> ' +
    'details -> constraints; be concrete about medium, composition, and lighting. Write the prompt ' +
    "in the user's language (Japanese if the user wrote in Japanese, unless English is requested).",
  version: '1.0.0',
  tags: ['image-generation', 'gpt-image', 'openai'],
};

export default gptImageTool;
