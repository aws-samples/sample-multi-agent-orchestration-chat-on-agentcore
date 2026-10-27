import { Readable } from 'node:stream';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';
import { pegasusVideoToTextTool } from './pegasus-video-to-text.js';
import { getToolHandler } from './index.js';

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeModelCommand: jest.fn((input) => ({ input })),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  GetObjectCommand: jest.fn((input) => ({ input })),
}));

const mockBedrockSend = jest.mocked(BedrockRuntimeClient).mock.results[0].value.send as jest.Mock;
const mockS3Send = jest.mocked(S3Client).mock.results[0].value.send as jest.Mock;

const context = { identityId: 'us-east-1:aaaa-bbbb', storagePath: '/project/' };
const uri = 's3://workspace/users/us-east-1:aaaa-bbbb/project/video.mp4';
const run = (input: Record<string, unknown> = {}) =>
  pegasusVideoToTextTool.handler({
    videoPath: uri,
    _context: context,
    ...input,
  });
const request = () => JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.USER_STORAGE_BUCKET_NAME = 'workspace';
  process.env.USER_STORAGE_BUCKET_OWNER = '111122223333';
  mockBedrockSend.mockResolvedValue({
    body: Buffer.from(JSON.stringify({ message: 'A scene', stopReason: 'stop' })),
  });
});

test('registry exposes the default and named handler', () => {
  expect(getToolHandler(null)).toBe(pegasusVideoToTextTool.handler);
  expect(getToolHandler('video_to_text')).toBe(pegasusVideoToTextTool.handler);
});

test('S3 invocation uses bucket owner, defaults and stopReason without downloading', async () => {
  expect(await run()).toEqual({ success: true, message: 'A scene', stopReason: 'stop' });
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockBedrockSend.mock.calls[0][0].input.modelId).toBe('global.twelvelabs.pegasus-1-5-v1:0');
  expect(request()).toEqual({
    analysis_mode: 'general',
    inputPrompt: 'Describe this video in detail.',
    mediaSource: { s3Location: { uri, bucketOwner: '111122223333' } },
    temperature: 0.2,
    maxOutputTokens: 1024,
  });
});

test.each(['video.mp4', '/tmp/ws/video.mp4'])(
  'workspace path %s reads only the authorized S3 object',
  async (videoPath) => {
    mockS3Send.mockResolvedValue({ ContentLength: 5, Body: Readable.from([Buffer.from('video')]) });
    await run({ videoPath });
    expect(mockS3Send.mock.calls[0][0].input).toEqual({
      Bucket: 'workspace',
      Key: 'users/us-east-1:aaaa-bbbb/project/video.mp4',
      ExpectedBucketOwner: '111122223333',
    });
    expect(request().mediaSource).toEqual({
      base64String: Buffer.from('video').toString('base64'),
    });
  }
);

test.each([
  's3://other/users/us-east-1:aaaa-bbbb/project/video.mp4',
  's3://workspace/users/us-east-1:cccc-dddd/project/video.mp4',
  's3://workspace/users/us-east-1:aaaa-bbbb/project-other/video.mp4',
  's3://workspace/users/us-east-1:aaaa-bbbb/project/../secret.mp4',
  's3://workspace/users/us-east-1:aaaa-bbbb/project/%2e%2e/secret.mp4',
  '../secret.mp4',
  'https://example.com/video',
  'file:///etc/passwd',
  'a\\..\\secret',
  '',
  '/',
])('rejects unauthorized or malformed path %s before any AWS call', async (videoPath) => {
  await expect(run({ videoPath })).rejects.toThrow();
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test.each([
  undefined,
  {},
  { identityId: 'other/user', storagePath: '/' },
  { ...context, storagePath: '/../' },
  { ...context, storagePath: '/project/%2f' },
])('fails closed on invalid context %j', async (_context) => {
  await expect(run({ _context })).rejects.toThrow();
  expect(mockBedrockSend).not.toHaveBeenCalled();
  expect(mockS3Send).not.toHaveBeenCalled();
});

test.each([
  { maxOutputTokens: 511 },
  { maxOutputTokens: 98305 },
  { maxOutputTokens: 512.5 },
  { temperature: -1 },
  { temperature: Number.NaN },
  { temperature: 1.1 },
  { modelId: 'amazon.nova-lite-v1:0' },
  { analysisMode: 'other' },
  { analysisMode: 'time_based_metadata' },
  { prompt: ' ' },
  { responseJsonSchema: [] },
])('rejects invalid parameters %j before invoking', async (input) => {
  await expect(run(input)).rejects.toThrow();
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test('passes segmentation fields and preserves stopReason/finish_reason', async () => {
  const segments = [
    {
      id: 'scene',
      description: 'Scenes',
      fields: [{ name: 'summary', type: 'string', description: 'Summary' }],
    },
  ];
  mockBedrockSend.mockResolvedValue({
    body: Buffer.from(
      JSON.stringify({
        segments: [],
        definition_errors: [],
        stopReason: 'length',
        finish_reason: 'length',
      })
    ),
  });
  expect(
    await run({
      analysisMode: 'time_based_metadata',
      segmentDefinitions: segments,
      modelId: 'us.twelvelabs.pegasus-1-5-v1:0',
      maxOutputTokens: 512,
      temperature: 0,
    })
  ).toMatchObject({ stopReason: 'length', finish_reason: 'length' });
  expect(request().segment_definitions).toEqual(segments);
});

test('passes structured output without rewriting the returned message', async () => {
  await run({ responseJsonSchema: { type: 'object' }, maxOutputTokens: 98304, temperature: 1 });
  expect(request().responseFormat).toEqual({ jsonSchema: { type: 'object' } });
});

test('rejects oversized base64 video without consuming it', async () => {
  const body = Readable.from([Buffer.from('video')]);
  mockS3Send.mockResolvedValue({ Body: body, ContentLength: 25 * 1024 * 1024 + 1 });
  await expect(run({ videoPath: 'video.mp4' })).rejects.toThrow('25 MiB');
  expect(body.destroyed).toBe(true);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test('enforces the stream byte limit even when ContentLength is incorrect', async () => {
  mockS3Send.mockResolvedValue({
    Body: Readable.from([Buffer.alloc(25 * 1024 * 1024 + 1)]),
    ContentLength: 1,
  });
  await expect(run({ videoPath: 'video.mp4' })).rejects.toThrow('base64 limit');
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test('propagates Bedrock failure rather than returning success', async () => {
  mockBedrockSend.mockRejectedValue(new Error('service failed'));
  await expect(run()).rejects.toThrow('service failed');
});
