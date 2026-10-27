import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { Tool, ToolInput, ToolResult, ToolValidationError } from '@moca/lambda-tools-shared';

const TOOL_NAME = 'video_to_text';
const MODEL_IDS = ['global.twelvelabs.pegasus-1-5-v1:0', 'us.twelvelabs.pegasus-1-5-v1:0'];
const MAX_BASE64_BYTES = 25 * 1024 * 1024;
const bedrock = new BedrockRuntimeClient({ region: process.env.PEGASUS_REGION || 'us-east-1' });
const s3 = new S3Client({});

function invalid(message: string, field: string): never {
  throw new ToolValidationError(message, TOOL_NAME, field);
}

function safeSegments(value: string): string[] {
  // Do not normalize traversal or encoded separators into an authorized prefix.
  if (
    /[\\%]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    invalid('Invalid video or storage path', 'videoPath');
  }
  const parts = value
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    invalid('Path traversal is not allowed', 'videoPath');
  }
  return parts;
}

async function handleVideoToText(input: ToolInput): Promise<ToolResult> {
  const context = input._context as { identityId?: string; storagePath?: string } | undefined;
  if (
    !context ||
    typeof context.identityId !== 'string' ||
    !/^[a-z0-9-]+:[a-f0-9-]+$/i.test(context.identityId) ||
    typeof context.storagePath !== 'string'
  ) {
    invalid('A Gateway-injected identityId and storagePath are required', '_context');
  }
  const bucket = process.env.USER_STORAGE_BUCKET_NAME;
  const owner = process.env.USER_STORAGE_BUCKET_OWNER;
  if (!bucket || !owner) throw new Error('Video storage is not configured');
  if (typeof input.videoPath !== 'string' || !input.videoPath.trim()) {
    invalid('videoPath is required', 'videoPath');
  }
  const prefix =
    ['users', context.identityId, ...safeSegments(context.storagePath)].join('/') + '/';
  const s3Match = /^s3:\/\/([^/]+)\/(.+)$/.exec(input.videoPath);
  let key: string;
  if (s3Match) {
    key = s3Match[2];
    safeSegments(key);
    if (s3Match[1] !== bucket || !key.startsWith(prefix) || key.length === prefix.length) {
      invalid('Video must be inside the caller workspace', 'videoPath');
    }
  } else {
    if (input.videoPath.includes('://'))
      invalid('Only S3 or workspace paths are supported', 'videoPath');
    const relative = input.videoPath.replace(/^\/tmp\/ws\//, '');
    const parts = safeSegments(relative);
    if (!parts.length) invalid('A video file is required', 'videoPath');
    key = prefix + parts.join('/');
  }

  const modelId = input.modelId ?? MODEL_IDS[0];
  if (typeof modelId !== 'string' || !MODEL_IDS.includes(modelId))
    invalid('Unsupported Pegasus inference profile', 'modelId');
  const mode = input.analysisMode ?? 'general';
  if (mode !== 'general' && mode !== 'time_based_metadata')
    invalid('Invalid analysisMode', 'analysisMode');
  const maxOutputTokens = input.maxOutputTokens ?? 1024;
  if (
    typeof maxOutputTokens !== 'number' ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 512 ||
    maxOutputTokens > 98304
  ) {
    invalid('maxOutputTokens must be an integer from 512 to 98304', 'maxOutputTokens');
  }
  const temperature = input.temperature ?? 0.2;
  if (
    typeof temperature !== 'number' ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 1
  )
    invalid('temperature must be from 0 to 1', 'temperature');
  const prompt = input.prompt ?? 'Describe this video in detail.';
  if (typeof prompt !== 'string' || !prompt.trim()) invalid('prompt must be nonempty', 'prompt');
  if (
    mode === 'time_based_metadata' &&
    (!Array.isArray(input.segmentDefinitions) || !input.segmentDefinitions.length)
  ) {
    invalid('segmentDefinitions are required for time_based_metadata', 'segmentDefinitions');
  }
  if (
    input.responseJsonSchema !== undefined &&
    (mode !== 'general' ||
      typeof input.responseJsonSchema !== 'object' ||
      input.responseJsonSchema === null ||
      Array.isArray(input.responseJsonSchema))
  ) {
    invalid('responseJsonSchema must be an object in general mode', 'responseJsonSchema');
  }

  let mediaSource: Record<string, unknown>;
  if (s3Match) {
    mediaSource = { s3Location: { uri: `s3://${bucket}/${key}`, bucketOwner: owner } };
  } else {
    // A Lambda cannot read the agent container's files: resolve workspace paths in S3.
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ExpectedBucketOwner: owner })
    );
    if (!(object.Body instanceof Readable)) throw new Error('Video could not be read');
    if (object.ContentLength === undefined || object.ContentLength > MAX_BASE64_BYTES) {
      object.Body.destroy();
      invalid(
        'Workspace videos must be at most 25 MiB; use an S3 URI for larger videos',
        'videoPath'
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of object.Body) {
      size += chunk.length;
      if (size > MAX_BASE64_BYTES) {
        object.Body.destroy();
        invalid('Video exceeds the base64 limit; use an S3 URI', 'videoPath');
      }
      chunks.push(chunk);
    }
    mediaSource = { base64String: Buffer.concat(chunks).toString('base64') };
  }

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        analysis_mode: mode,
        inputPrompt: prompt,
        mediaSource,
        temperature,
        maxOutputTokens,
        ...(input.segmentDefinitions !== undefined && {
          segment_definitions: input.segmentDefinitions,
        }),
        ...(input.responseJsonSchema !== undefined && {
          responseFormat: { jsonSchema: input.responseJsonSchema },
        }),
      }),
    })
  );
  const result = JSON.parse(Buffer.from(response.body).toString('utf8')) as Record<string, unknown>;
  return { success: true, ...result };
}

export const pegasusVideoToTextTool: Tool = {
  name: TOOL_NAME,
  handler: handleVideoToText,
  description: 'Analyze a video in the caller workspace with TwelveLabs Pegasus 1.5.',
  version: '1.0.0',
  tags: ['video-analysis', 'bedrock', 'pegasus'],
};
