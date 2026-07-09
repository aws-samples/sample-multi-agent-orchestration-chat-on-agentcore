/**
 * OpenAI gpt-image EDIT tool implementation (Lambda)
 *
 * Edits / composes images using OpenAI's Images Edit API (gpt-image family) and
 * saves the result to the caller's S3 storage, returning S3 paths.
 *
 * Multi-turn editing is stateless by design: the tool takes s3:// paths as input
 * and returns s3:// paths as output. To iterate ("now make the sky purple"), the
 * agent re-feeds the previous result's path back into `imagePaths`. This mirrors
 * how Moca keeps session history as the single source of state, rather than
 * relying on OpenAI's server-side previous_response_id chaining.
 *
 * User context (identityId, storagePath) is injected by the Gateway Interceptor
 * into the `_context` field, exactly as nova-canvas and gpt_image use it.
 */

import {
  ToolInput,
  ToolResult,
  Tool,
  ToolValidationError,
  logger,
} from '@moca/lambda-tools-shared';
import { callOpenAiImageEditApi, type EditImagePart } from './gpt-image-common.js';
import { saveImageToS3, readS3Object } from './s3-io.js';
import {
  DEFAULT_MODEL,
  MAX_IMAGES,
  VALID_SIZES,
  VALID_QUALITIES,
  type UserContext,
} from './constants.js';

const TOOL_NAME = 'gpt_image_edit';
// The Images Edit endpoint accepts multiple source images (references) in a
// single request. Cap it to keep request size and cost bounded.
const MAX_INPUT_IMAGES = 4;

interface GptImageEditInput extends ToolInput {
  prompt?: string;
  imagePaths?: string[];
  maskPath?: string;
  size?: string;
  quality?: string;
  numberOfImages?: number;
  outputPath?: string;
  _context?: UserContext;
}

function generateFilename(index: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `gpt-image-edit-${timestamp}-${index + 1}.png`;
}

/**
 * Load an s3:// image into the multipart part shape. gpt-image edits accept PNG,
 * JPEG and WebP; we send the bytes as-is and infer the content type from the key
 * extension (defaulting to png).
 */
async function loadImagePart(s3Uri: string): Promise<EditImagePart> {
  const bytes = await readS3Object(s3Uri);
  const lower = s3Uri.toLowerCase();
  const [contentType, ext] =
    lower.endsWith('.jpg') || lower.endsWith('.jpeg')
      ? ['image/jpeg', 'jpg']
      : lower.endsWith('.webp')
        ? ['image/webp', 'webp']
        : ['image/png', 'png'];
  return { bytes, filename: `image.${ext}`, contentType };
}

async function handleGptImageEdit(input: ToolInput): Promise<ToolResult> {
  const editInput = input as GptImageEditInput;

  // Validate required fields
  if (!editInput.prompt) {
    throw new ToolValidationError("'prompt' parameter is required", TOOL_NAME, 'prompt');
  }

  const imagePaths = editInput.imagePaths ?? [];
  if (imagePaths.length === 0) {
    throw new ToolValidationError(
      "'imagePaths' must contain at least one s3:// image path to edit",
      TOOL_NAME,
      'imagePaths'
    );
  }
  if (imagePaths.length > MAX_INPUT_IMAGES) {
    throw new ToolValidationError(
      `Too many input images: ${imagePaths.length}. Provide at most ${MAX_INPUT_IMAGES}.`,
      TOOL_NAME,
      'imagePaths'
    );
  }
  for (const p of imagePaths) {
    if (!p.startsWith('s3://')) {
      throw new ToolValidationError(
        `Image path must be an s3:// URI, got: ${p}`,
        TOOL_NAME,
        'imagePaths'
      );
    }
  }
  if (editInput.maskPath && !editInput.maskPath.startsWith('s3://')) {
    throw new ToolValidationError(
      `Mask path must be an s3:// URI, got: ${editInput.maskPath}`,
      TOOL_NAME,
      'maskPath'
    );
  }

  // Extract user context (injected by Gateway Interceptor)
  const userContext = editInput._context;
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
  const size = editInput.size ?? 'auto';
  const quality = editInput.quality ?? 'auto';
  const numberOfImages = Math.min(Math.max(editInput.numberOfImages ?? 1, 1), MAX_IMAGES);

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

  logger.info('GPT_IMAGE_EDIT_START', {
    promptLength: editInput.prompt.length,
    inputImageCount: imagePaths.length,
    hasMask: Boolean(editInput.maskPath),
    size,
    quality,
    numberOfImages,
    identityId,
  });

  // Read source images (and optional mask) from the user's S3 storage.
  const images = await Promise.all(imagePaths.map(loadImagePart));
  const mask = editInput.maskPath ? await loadImagePart(editInput.maskPath) : undefined;

  // Invoke OpenAI Images Edit API
  const startTime = Date.now();
  const apiResponse = await callOpenAiImageEditApi({
    model: DEFAULT_MODEL,
    prompt: editInput.prompt,
    images,
    mask,
    n: numberOfImages,
    size,
    quality,
  });
  const duration = Date.now() - startTime;

  const results = apiResponse.data ?? [];
  logger.info('GPT_IMAGE_EDIT_COMPLETE', { imageCount: results.length, durationMs: duration });

  // Save edited images to S3 (gpt-image returns base64).
  const s3Paths: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const b64 = results[i].b64_json;
    if (!b64) {
      logger.warn(`Edited image ${i + 1} has no b64_json payload; skipping`);
      continue;
    }

    const filename =
      editInput.outputPath && results.length === 1
        ? editInput.outputPath
        : editInput.outputPath
          ? `${editInput.outputPath}-${i + 1}.png`
          : generateFilename(i);

    try {
      const s3Path = await saveImageToS3(b64, storagePath, filename, identityId, 'gpt-image-edit');
      if (s3Path) s3Paths.push(s3Path);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`Failed to save edited image ${i + 1} to S3: ${msg}`);
    }
  }

  const result: ToolResult = {
    success: true,
    prompt: editInput.prompt,
    configuration: { model: DEFAULT_MODEL, size, quality, numberOfImages },
    inputImageCount: imagePaths.length,
    imageCount: results.length,
    s3Paths,
    durationMs: duration,
    message: `Successfully edited ${imagePaths.length} input image(s) into ${results.length} result(s) in ${duration}ms.${
      s3Paths.length > 0 ? ` Saved to: ${s3Paths.join(', ')}` : ''
    } To iterate further, call ${TOOL_NAME} again with one of these result paths in imagePaths.`,
  };

  return result;
}

export const gptImageEditTool: Tool = {
  name: TOOL_NAME,
  handler: handleGptImageEdit,
  description:
    'Edit, refine, or compose images using OpenAI gpt-image. Takes one or more existing images ' +
    '(by s3:// path) plus a text prompt, and optionally a mask for inpainting. Returns new s3:// ' +
    'paths. For multi-turn editing, feed a previous result path back in to iterate. Use the ' +
    "'change only X, keep everything else the same' pattern and restate what to preserve on each " +
    "iteration. Write the prompt in the user's language (Japanese if the user wrote in Japanese, " +
    'unless English is requested).',
  version: '1.0.0',
  tags: ['image-generation', 'image-editing', 'gpt-image', 'openai'],
};

export default gptImageEditTool;
