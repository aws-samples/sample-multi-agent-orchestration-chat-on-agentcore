/**
 * Nova Reel tool implementation (Lambda)
 *
 * Generates videos using Amazon Nova Reel via Bedrock async invocation and saves them to S3.
 * User context (userId, storagePath) is injected by the Gateway Interceptor
 * into the _context field of the tool input.
 */

import {
  BedrockRuntimeClient,
  StartAsyncInvokeCommand,
  GetAsyncInvokeCommand,
  ListAsyncInvokesCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ToolInput, ToolResult, Tool, ToolValidationError, logger } from '@moca/lambda-tools-shared';

// ── Constants ──

const TOOL_NAME = 'nova_reel';
const NOVA_REEL_MODEL_ID = 'amazon.nova-reel-v1:1';

const novaReelRegion = process.env.NOVA_REEL_REGION || 'us-east-1';
const userStorageBucketName = process.env.USER_STORAGE_BUCKET_NAME;

// Default values
const DEFAULT_DURATION = 6;
const DEFAULT_DIMENSION = '1280x720';
const DEFAULT_FPS = 24;
const DEFAULT_POLLING_INTERVAL = 30; // seconds
const DEFAULT_MAX_WAIT_TIME = 840; // seconds (14 minutes, within Lambda 15-min limit)

// ── Clients ──

const bedrockClient = new BedrockRuntimeClient({ region: novaReelRegion });
const s3Client = new S3Client({});

// ── Types ──

type VideoDuration = 6 | 120;
type VideoDimension = '1280x720';
const VALID_DIMENSIONS: VideoDimension[] = ['1280x720'];
type JobStatus = 'InProgress' | 'Completed' | 'Failed';
type SortOrder = 'Ascending' | 'Descending';
type NovaReelAction = 'start' | 'status' | 'list';

/** Interceptor-injected context */
interface UserContext {
  /** Identity Pool identityId (REGION:uuid). Injected by gateway-interceptor.
   *  Required — used as S3 path key for per-user isolation. */
  identityId: string;
  storagePath: string;
}

interface NovaReelInput extends ToolInput {
  action?: NovaReelAction;
  // Start action params
  prompt?: string;
  negativePrompt?: string;
  imageBase64?: string;
  duration?: number;
  dimension?: string;
  fps?: number;
  seed?: number;
  outputPath?: string;
  waitForCompletion?: boolean;
  pollingInterval?: number;
  maxWaitTime?: number;
  // Status action params
  invocationArn?: string;
  // List action params
  statusFilter?: string;
  maxResults?: number;
  sortOrder?: string;
  // Injected context
  _context?: UserContext;
}

interface StartVideoResult {
  success: boolean;
  action: 'start';
  invocationArn: string;
  status: string;
  estimatedTime: string;
  outputS3Uri?: string;
  s3Path?: string;
  message: string;
}

interface StatusResult {
  success: boolean;
  action: 'status';
  invocationArn: string;
  status: string;
  progress?: number;
  elapsedTime?: number;
  outputS3Uri?: string;
  s3Path?: string;
  failureMessage?: string;
  message: string;
}

interface ListJobsResult {
  success: boolean;
  action: 'list';
  jobs: Array<{
    invocationArn: string;
    status: string;
    submitTime: string;
    endTime?: string;
    outputS3Uri?: string;
  }>;
  count: number;
  message: string;
}

// ── Helpers ──

function generateFilename(seed?: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const seedStr = seed !== undefined ? `-seed-${seed}` : '';
  return `video-${timestamp}${seedStr}.mp4`;
}

function getEstimatedTime(duration: number): string {
  if (duration <= 6) {
    return 'approximately 90 seconds';
  }
  return 'approximately 14-17 minutes';
}

function getTempOutputPrefix(identityId: string): string {
  return `temp/nova-reel/${identityId}/${Date.now()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect image format from base64 string
 */
function detectImageFormat(base64: string): 'png' | 'jpeg' | 'gif' | 'webp' {
  if (base64.startsWith('/9j/')) return 'jpeg';
  if (base64.startsWith('iVBORw')) return 'png';
  if (base64.startsWith('R0lGOD')) return 'gif';
  if (base64.startsWith('UklGR')) return 'webp';
  return 'png';
}

/**
 * Get user-friendly display path from a full S3 path
 */
function getDisplayPath(s3Path: string, identityId: string): string {
  const prefix = `users/${identityId}/`;
  if (s3Path.includes(prefix)) {
    const index = s3Path.indexOf(prefix);
    const relativePath = s3Path.substring(index + prefix.length);
    if (relativePath) {
      return `/${relativePath}`;
    }
  }
  return s3Path;
}

/**
 * Copy video from temp location to user storage
 */
async function copyVideoToUserStorage(
  sourceS3Uri: string,
  storagePath: string,
  outputPath: string | undefined,
  identityId: string
): Promise<string> {
  try {
    if (!userStorageBucketName) {
      logger.warn('USER_STORAGE_BUCKET_NAME not configured, skipping video copy');
      return '';
    }

    // Parse source S3 URI
    const sourceMatch = sourceS3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!sourceMatch) {
      logger.warn(`Invalid source S3 URI: ${sourceS3Uri}`);
      return '';
    }

    const [, sourceBucket, sourceKey] = sourceMatch;

    // Nova Reel outputs video as output.mp4 in the specified directory
    const videoSourceKey = sourceKey.endsWith('/')
      ? `${sourceKey}output.mp4`
      : `${sourceKey}/output.mp4`;

    // Check if source video exists
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: sourceBucket,
          Key: videoSourceKey,
        })
      );
    } catch {
      logger.warn(`Source video not found: s3://${sourceBucket}/${videoSourceKey}`);
      return '';
    }

    // Build destination path using identityId (Identity Pool sub).
    const basePath = `users/${identityId}/${storagePath}/videos`.replace(/\/+/g, '/');
    const filename = outputPath || generateFilename();
    const destKey = `${basePath}/${filename}`.replace(/\/+/g, '/');

    // Copy to user storage
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: userStorageBucketName,
        Key: destKey,
        CopySource: `${sourceBucket}/${videoSourceKey}`,
        MetadataDirective: 'REPLACE',
        ContentType: 'video/mp4',
        Metadata: {
          'generated-by': 'nova-reel',
          'generated-at': new Date().toISOString(),
          'source-uri': sourceS3Uri,
        },
      })
    );

    const s3Path = `s3://${userStorageBucketName}/${destKey}`;
    logger.info('Video copied to user storage', { s3Path });
    return s3Path;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to copy video to user storage: ${errorMessage}`);
    return '';
  }
}

// ── Core Actions ──

/**
 * Start a video generation job
 */
async function startVideoGeneration(
  input: NovaReelInput,
  storagePath: string,
  identityId: string
): Promise<StartVideoResult> {
  const prompt = input.prompt!;
  const duration = (input.duration as VideoDuration) || DEFAULT_DURATION;
  const dimension = (input.dimension as VideoDimension) || DEFAULT_DIMENSION;

  // Validate dimension (currently only 1280x720 is supported by Nova Reel v1:1)
  if (!VALID_DIMENSIONS.includes(dimension)) {
    return {
      success: false,
      action: 'start',
      invocationArn: '',
      status: 'Failed',
      estimatedTime: '',
      message: `Invalid dimension: ${dimension}. Currently only ${VALID_DIMENSIONS.join(', ')} is supported.`,
    };
  }
  const fps = input.fps || DEFAULT_FPS;
  const seed = input.seed !== undefined ? input.seed : Math.floor(Math.random() * 2147483646);

  logger.info('NOVA_REEL_START', {
    promptLength: prompt.length,
    duration,
    dimension,
    identityId,
  });

  try {
    // Build request body
    const requestBody: Record<string, unknown> = {
      taskType: 'TEXT_VIDEO',
      textToVideoParams: {
        text: prompt,
      },
      videoGenerationConfig: {
        durationSeconds: duration,
        fps,
        dimension,
        seed,
      },
    };

    // Add image if provided (for Image-to-Video)
    if (input.imageBase64) {
      const format = detectImageFormat(input.imageBase64);
      (requestBody.textToVideoParams as Record<string, unknown>).images = [
        {
          format,
          source: {
            bytes: input.imageBase64,
          },
        },
      ];
    }

    // Setup output S3 location
    if (!userStorageBucketName) {
      throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
    }
    const outputPrefix = getTempOutputPrefix(identityId);
    const outputS3Uri = `s3://${userStorageBucketName}/${outputPrefix}/`;

    // Start async invocation
    const response = await bedrockClient.send(
      new StartAsyncInvokeCommand({
        modelId: NOVA_REEL_MODEL_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        modelInput: requestBody as any,
        outputDataConfig: {
          s3OutputDataConfig: {
            s3Uri: outputS3Uri,
          },
        },
      })
    );

    const invocationArn = response.invocationArn!;
    logger.info('NOVA_REEL_STARTED', { invocationArn });

    // If waitForCompletion is requested, poll for completion
    if (input.waitForCompletion) {
      const statusResult = await waitForCompletion(
        invocationArn,
        storagePath,
        input.outputPath,
        input.pollingInterval || DEFAULT_POLLING_INTERVAL,
        input.maxWaitTime || DEFAULT_MAX_WAIT_TIME,
        identityId
      );

      return {
        success: statusResult.status === 'Completed',
        action: 'start',
        invocationArn,
        status: statusResult.status,
        estimatedTime: getEstimatedTime(duration),
        outputS3Uri: statusResult.outputS3Uri,
        s3Path: statusResult.s3Path,
        message: statusResult.message,
      };
    }

    return {
      success: true,
      action: 'start',
      invocationArn,
      status: 'InProgress',
      estimatedTime: getEstimatedTime(duration),
      message: `Video generation job started. It will take ${getEstimatedTime(duration)} to complete.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to start video generation: ${errorMessage}`);

    return {
      success: false,
      action: 'start',
      invocationArn: '',
      status: 'Failed',
      estimatedTime: '',
      message: `Failed to start video generation: ${errorMessage}`,
    };
  }
}

/**
 * Wait for job completion with polling
 */
async function waitForCompletion(
  invocationArn: string,
  storagePath: string,
  outputPath?: string,
  pollingInterval: number = DEFAULT_POLLING_INTERVAL,
  maxWaitTime: number = DEFAULT_MAX_WAIT_TIME,
  identityId: string = ''
): Promise<StatusResult> {
  const startTime = Date.now();
  const maxEndTime = startTime + maxWaitTime * 1000;

  logger.info('NOVA_REEL_WAIT', { invocationArn, maxWaitTime });

  while (Date.now() < maxEndTime) {
    const statusResult = await getJobStatus(invocationArn, storagePath, outputPath, identityId);

    if (statusResult.status === 'Completed' || statusResult.status === 'Failed') {
      return statusResult;
    }

    logger.info(`Job still in progress, waiting ${pollingInterval}s...`);
    await sleep(pollingInterval * 1000);
  }

  const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
  return {
    success: false,
    action: 'status',
    invocationArn,
    status: 'InProgress',
    elapsedTime,
    message: `Maximum wait time (${maxWaitTime} seconds) exceeded. Job is still in progress. Use action="status" with the invocationArn to check later.`,
  };
}

/**
 * Get job status
 */
async function getJobStatus(
  invocationArn: string,
  storagePath: string,
  outputPath?: string,
  identityId: string = ''
): Promise<StatusResult> {
  logger.info('NOVA_REEL_STATUS', { invocationArn });

  try {
    const response = await bedrockClient.send(new GetAsyncInvokeCommand({ invocationArn }));

    const status = response.status as JobStatus;
    const submitTime = response.submitTime;

    const elapsedTime = submitTime
      ? Math.floor((Date.now() - submitTime.getTime()) / 1000)
      : undefined;

    // Calculate progress estimate
    let progress: number | undefined;
    if (status === 'InProgress' && elapsedTime !== undefined) {
      const estimatedTotal = 90;
      progress = Math.min(95, Math.floor((elapsedTime / estimatedTotal) * 100));
    } else if (status === 'Completed') {
      progress = 100;
    }

    let outputS3Uri: string | undefined;
    let s3Path: string | undefined;

    if (status === 'Completed' && response.outputDataConfig?.s3OutputDataConfig?.s3Uri) {
      outputS3Uri = response.outputDataConfig.s3OutputDataConfig.s3Uri;

      // Copy video to user storage
      const userS3Path = await copyVideoToUserStorage(
        outputS3Uri,
        storagePath,
        outputPath,
        identityId
      );
      if (userS3Path) {
        s3Path = getDisplayPath(userS3Path, identityId);
        outputS3Uri = userS3Path;
      }
    }

    let message: string;
    if (status === 'Completed') {
      message = s3Path
        ? `Video generation completed. Saved to: ${s3Path}`
        : 'Video generation completed.';
    } else if (status === 'Failed') {
      message = `Video generation failed: ${response.failureMessage || 'Unknown error'}`;
    } else {
      message = `Generating video... (elapsed: ${elapsedTime || 0}s, progress: ${progress || 0}%)`;
    }

    return {
      success: status === 'Completed',
      action: 'status',
      invocationArn,
      status,
      progress,
      elapsedTime,
      outputS3Uri,
      s3Path,
      failureMessage: response.failureMessage,
      message,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to get job status: ${errorMessage}`);

    return {
      success: false,
      action: 'status',
      invocationArn,
      status: 'Failed',
      failureMessage: errorMessage,
      message: `Failed to get job status: ${errorMessage}`,
    };
  }
}

/**
 * List video generation jobs
 */
async function listJobs(input: NovaReelInput): Promise<ListJobsResult> {
  const maxResults = input.maxResults || 10;
  const sortOrder = (input.sortOrder as SortOrder) || 'Descending';

  logger.info('NOVA_REEL_LIST', {
    statusFilter: input.statusFilter,
    maxResults,
  });

  try {
    const response = await bedrockClient.send(
      new ListAsyncInvokesCommand({
        statusEquals: input.statusFilter as JobStatus | undefined,
        maxResults,
        sortOrder,
      })
    );

    const summaries = response.asyncInvokeSummaries || [];
    const jobs = summaries.map((summary) => ({
      invocationArn: summary.invocationArn!,
      status: summary.status as string,
      submitTime: summary.submitTime?.toISOString() || '',
      endTime: summary.endTime?.toISOString(),
      outputS3Uri: summary.outputDataConfig?.s3OutputDataConfig?.s3Uri,
    }));

    return {
      success: true,
      action: 'list',
      jobs,
      count: jobs.length,
      message: `Found ${jobs.length} job(s).`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to list jobs: ${errorMessage}`);

    return {
      success: false,
      action: 'list',
      jobs: [],
      count: 0,
      message: `Failed to list jobs: ${errorMessage}`,
    };
  }
}

// ── Main Handler ──

async function handleNovaReel(input: ToolInput): Promise<ToolResult> {
  const reelInput = input as NovaReelInput;

  // Validate action
  const action = reelInput.action;
  if (!action) {
    throw new ToolValidationError("'action' parameter is required", TOOL_NAME, 'action');
  }

  if (!['start', 'status', 'list'].includes(action)) {
    throw new ToolValidationError(
      `Invalid action: ${action}. Must be one of: start, status, list`,
      TOOL_NAME,
      'action'
    );
  }

  // Extract user context (injected by Gateway Interceptor)
  const userContext = reelInput._context;
  if (!userContext?.identityId) {
    throw new ToolValidationError(
      'identityId not found in user context. Ensure the Gateway Interceptor is configured with IDENTITY_POOL_ID.',
      TOOL_NAME,
      '_context'
    );
  }

  const { identityId, storagePath: rawStoragePath } = userContext;
  const storagePath = rawStoragePath || '/';

  logger.info('NOVA_REEL_ACTION', { action, identityId });

  switch (action) {
    case 'start': {
      if (!reelInput.prompt) {
        throw new ToolValidationError(
          "'prompt' parameter is required for start action",
          TOOL_NAME,
          'prompt'
        );
      }
      return (await startVideoGeneration(
        reelInput,
        storagePath,
        identityId
      )) as unknown as ToolResult;
    }

    case 'status': {
      if (!reelInput.invocationArn) {
        throw new ToolValidationError(
          "'invocationArn' parameter is required for status action",
          TOOL_NAME,
          'invocationArn'
        );
      }

      let result: StatusResult;
      if (reelInput.waitForCompletion) {
        result = await waitForCompletion(
          reelInput.invocationArn,
          storagePath,
          reelInput.outputPath,
          reelInput.pollingInterval || DEFAULT_POLLING_INTERVAL,
          reelInput.maxWaitTime || DEFAULT_MAX_WAIT_TIME,
          identityId
        );
      } else {
        result = await getJobStatus(
          reelInput.invocationArn,
          storagePath,
          reelInput.outputPath,
          identityId
        );
      }
      return result as unknown as ToolResult;
    }

    case 'list': {
      return (await listJobs(reelInput)) as unknown as ToolResult;
    }

    default:
      throw new ToolValidationError(`Unknown action: ${action}`, TOOL_NAME, 'action');
  }
}

// ── Tool Export ──

export const novaReelTool: Tool = {
  name: TOOL_NAME,
  handler: handleNovaReel,
  description:
    'Generate videos using Amazon Nova Reel on Bedrock. ' +
    'Supports text-to-video and image-to-video generation. ' +
    'Saves generated videos to user S3 storage and returns S3 paths.',
  version: '1.0.0',
  tags: ['video-generation', 'nova-reel', 'bedrock'],
};

export default novaReelTool;
