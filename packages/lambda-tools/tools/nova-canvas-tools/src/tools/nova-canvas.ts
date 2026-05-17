/**
 * Nova Canvas tool implementation (Lambda)
 *
 * Generates images using Amazon Nova Canvas via Bedrock and saves them to S3.
 * User context (userId, storagePath) is injected by the Gateway Interceptor
 * into the _context field of the tool input.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ToolInput, ToolResult, Tool, ToolValidationError, logger } from '@moca/lambda-tools-shared';

const TOOL_NAME = 'nova_canvas';
const NOVA_CANVAS_MODEL_ID = 'amazon.nova-canvas-v1:0';
const VALID_DIMENSIONS = [512, 768, 1024];
const MAX_IMAGES = 5;
const MAX_SEED = 858993459;

const novaCanvasRegion = process.env.NOVA_CANVAS_REGION || 'us-east-1';
const userStorageBucketName = process.env.USER_STORAGE_BUCKET_NAME;

const bedrockClient = new BedrockRuntimeClient({ region: novaCanvasRegion });
const s3Client = new S3Client({});

/**
 * Interceptor-injected context
 */
interface UserContext {
  /** Identity Pool identityId (REGION:uuid). Injected by gateway-interceptor.
   *  Required — used as S3 path key for per-user isolation. */
  identityId: string;
  storagePath: string;
}

interface NovaCanvasInput extends ToolInput {
  prompt?: string;
  width?: number;
  height?: number;
  numberOfImages?: number;
  seed?: number;
  outputPath?: string;
  _context?: UserContext;
}

interface NovaCanvasApiResponse {
  images: string[];
}

function generateFilename(seed: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `image-${timestamp}-seed-${seed}.png`;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function saveImageToS3(
  imageBase64: string,
  storagePath: string,
  filename: string,
  identityId: string
): Promise<string> {
  if (!userStorageBucketName) {
    logger.warn('USER_STORAGE_BUCKET_NAME not configured, skipping S3 upload');
    return '';
  }

  const basePath = `users/${identityId}/${storagePath}`.replace(/\/+/g, '/');
  const s3Key = `${basePath}/${filename}`.replace(/\/+/g, '/');
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  await s3Client.send(
    new PutObjectCommand({
      Bucket: userStorageBucketName,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: 'image/png',
      Metadata: {
        'generated-by': 'nova-canvas',
        'generated-at': new Date().toISOString(),
      },
    })
  );

  const s3Path = `s3://${userStorageBucketName}/${s3Key}`;
  logger.info('Image saved to S3', { s3Path, size: formatFileSize(imageBuffer.length) });
  return s3Path;
}

async function handleNovaCanvas(input: ToolInput): Promise<ToolResult> {
  const novaInput = input as NovaCanvasInput;

  // Validate required fields
  if (!novaInput.prompt) {
    throw new ToolValidationError("'prompt' parameter is required", TOOL_NAME, 'prompt');
  }

  if (novaInput.prompt.length > 1024) {
    throw new ToolValidationError('Prompt must be 1024 characters or less', TOOL_NAME, 'prompt');
  }

  // Extract user context (injected by Gateway Interceptor)
  const userContext = novaInput._context;
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
  const width = novaInput.width ?? 512;
  const height = novaInput.height ?? 512;
  const numberOfImages = Math.min(Math.max(novaInput.numberOfImages ?? 1, 1), MAX_IMAGES);
  const seed = novaInput.seed ?? Math.floor(Math.random() * MAX_SEED);

  if (!VALID_DIMENSIONS.includes(width)) {
    throw new ToolValidationError(
      `Invalid width: ${width}. Must be one of: ${VALID_DIMENSIONS.join(', ')}`,
      TOOL_NAME,
      'width'
    );
  }

  if (!VALID_DIMENSIONS.includes(height)) {
    throw new ToolValidationError(
      `Invalid height: ${height}. Must be one of: ${VALID_DIMENSIONS.join(', ')}`,
      TOOL_NAME,
      'height'
    );
  }

  logger.info('NOVA_CANVAS_START', {
    promptLength: novaInput.prompt.length,
    width,
    height,
    numberOfImages,
    seed,
    identityId,
  });

  // Invoke Nova Canvas
  const startTime = Date.now();
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: NOVA_CANVAS_MODEL_ID,
      contentType: 'application/json',
      body: JSON.stringify({
        taskType: 'TEXT_IMAGE',
        textToImageParams: { text: novaInput.prompt },
        imageGenerationConfig: {
          seed,
          quality: 'standard',
          width,
          height,
          numberOfImages,
        },
      }),
    })
  );

  const responseBody = JSON.parse(
    response.body!.transformToString('utf-8')
  ) as NovaCanvasApiResponse;
  const duration = Date.now() - startTime;

  logger.info('NOVA_CANVAS_COMPLETE', {
    imageCount: responseBody.images.length,
    durationMs: duration,
  });

  // Save images to S3
  const s3Paths: string[] = [];
  for (let i = 0; i < responseBody.images.length; i++) {
    const filename =
      novaInput.outputPath && responseBody.images.length === 1
        ? novaInput.outputPath
        : novaInput.outputPath
          ? `${novaInput.outputPath}-${i + 1}.png`
          : generateFilename(seed + i);

    try {
      const s3Path = await saveImageToS3(responseBody.images[i], storagePath, filename, identityId);
      if (s3Path) s3Paths.push(s3Path);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`Failed to save image ${i + 1} to S3: ${msg}`);
    }
  }

  // Build result (no base64 data — only S3 paths to avoid Lambda response size limit)
  const result: ToolResult = {
    success: true,
    prompt: novaInput.prompt,
    configuration: { width, height, numberOfImages, seed },
    imageCount: responseBody.images.length,
    s3Paths,
    durationMs: duration,
    message: `Successfully generated ${responseBody.images.length} image(s) in ${duration}ms.${
      s3Paths.length > 0 ? ` Saved to: ${s3Paths.join(', ')}` : ''
    }`,
  };

  return result;
}

export const novaCanvasTool: Tool = {
  name: TOOL_NAME,
  handler: handleNovaCanvas,
  description:
    'Generate images using Amazon Nova Canvas on Bedrock. ' +
    'Saves generated images to user S3 storage and returns S3 paths.',
  version: '1.0.0',
  tags: ['image-generation', 'nova-canvas', 'bedrock'],
};

export default novaCanvasTool;
