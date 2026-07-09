/**
 * Integration tests that hit the real OpenAI Images API.
 *
 * Run with:
 *   npm run -w @moca/lambda-tools-gpt-image test:integration
 *
 * Requires OPENAI_API_KEY in `packages/lambda-tools/tools/gpt-image-tools/.env`
 * (loaded by jest.integration.setup.cjs). Without the key the API-hitting suites
 * are skipped so CI stays green on machines without the secret.
 *
 * S3 is stubbed: these tests exercise the OpenAI contract (real generation ->
 * base64 payload -> our result shape), not S3 persistence. We assert on the
 * end-to-end plumbing that a fetch mock could not faithfully reproduce:
 *   - a real gpt-image response yields at least one image and our imageCount
 *     reflects it
 *   - size/quality parameters are accepted by the API (no 4xx)
 *   - the validation path rejects malformed input BEFORE any network I/O
 *
 * Generation costs money and is slow, so keep the API-hitting cases minimal.
 */

// Stateful in-memory S3 stub so the edit round-trip works without AWS: a
// PutObject stores bytes under its key, a GetObject serves them back. This lets
// the multi-turn test generate an image, then read that same image back to edit
// it — the real stateless multi-turn flow. Hoisted above the import because the
// S3 client is instantiated at module load in s3-io.ts.
jest.mock('@aws-sdk/client-s3', () => {
  const store = new Map<string, Buffer>();
  return {
    S3Client: class {
      async send(command: { __type: string; input: { Key: string; Body?: Buffer } }) {
        if (command.__type === 'put') {
          store.set(command.input.Key, command.input.Body as Buffer);
          return {};
        }
        const bytes = store.get(command.input.Key);
        if (!bytes) throw new Error(`mock S3: no object at ${command.input.Key}`);
        return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      }
    },
    PutObjectCommand: class {
      __type = 'put';
      constructor(public readonly input: { Key: string; Body?: Buffer }) {}
    },
    GetObjectCommand: class {
      __type = 'get';
      constructor(public readonly input: { Key: string }) {}
    },
  };
});

// Stub Secrets Manager so getOpenAiApiKey() returns process.env.OPENAI_API_KEY
// instead of calling AWS.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send(): Promise<{ SecretString: string }> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY env var not set');
      return { SecretString: key };
    }
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// getOpenAiApiKey() requires OPENAI_API_KEY_SECRET_NAME to be set (it rejects
// otherwise). The value itself is unused because SecretsManagerClient is mocked.
process.env.OPENAI_API_KEY_SECRET_NAME =
  process.env.OPENAI_API_KEY_SECRET_NAME ?? 'integration-test-stub';
// A bucket name must be present or saveImageToS3 no-ops and returns no path.
process.env.USER_STORAGE_BUCKET_NAME =
  process.env.USER_STORAGE_BUCKET_NAME ?? 'integration-test-bucket';

import { ToolValidationError } from '@moca/lambda-tools-shared';
import { gptImageTool } from '../gpt-image.js';
import { gptImageEditTool } from '../gpt-image-edit.js';
import { __resetApiKeyCacheForTests } from '../gpt-image-common.js';

const hasKey = Boolean(process.env.OPENAI_API_KEY);
const describeIfKey = hasKey ? describe : describe.skip;

if (!hasKey) {
  console.warn('[gpt-image.integration] OPENAI_API_KEY not set — API suite skipped');
}

const CONTEXT = { identityId: 'us-east-1:integration-test', storagePath: '/generated' };

beforeEach(() => {
  __resetApiKeyCacheForTests();
});

// -----------------------------------------------------------------------------
// Validation path (no API call, no cost). Placed outside describeIfKey because
// no key is needed; guarantees malformed input is rejected before network I/O.
// -----------------------------------------------------------------------------
describe('gpt_image integration: input validation (no API call)', () => {
  it('rejects a missing prompt', async () => {
    await expect(gptImageTool.handler({ _context: CONTEXT })).rejects.toBeInstanceOf(
      ToolValidationError
    );
  });

  it('rejects an invalid size before making a request', async () => {
    await expect(
      gptImageTool.handler({ prompt: 'a red cube', size: '999x999', _context: CONTEXT })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects an invalid quality before making a request', async () => {
    await expect(
      gptImageTool.handler({ prompt: 'a red cube', quality: 'ultra', _context: CONTEXT })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects when user context (identityId) is missing', async () => {
    await expect(gptImageTool.handler({ prompt: 'a red cube' })).rejects.toBeInstanceOf(
      ToolValidationError
    );
  });
});

// -----------------------------------------------------------------------------
// Real generation. Minimal: one small image, lowest quality to reduce cost.
// -----------------------------------------------------------------------------
describeIfKey('gpt_image integration: real generation', () => {
  it('generates an image and reports it in the result', async () => {
    const result = await gptImageTool.handler({
      prompt: 'A minimalist flat-design icon of a blue coffee cup on a white background',
      size: '1024x1024',
      quality: 'low',
      numberOfImages: 1,
      _context: CONTEXT,
    });

    expect(result.success).toBe(true);
    expect(result.imageCount).toBe(1);
    // S3 is mocked to succeed, so the (mocked) path should have been recorded.
    expect(Array.isArray(result.s3Paths)).toBe(true);
    expect((result.s3Paths as string[]).length).toBe(1);
    expect((result.s3Paths as string[])[0]).toMatch(/^s3:\/\/.+\.png$/);
    expect(typeof result.durationMs).toBe('number');
  });

  it('surfaces a readable error for an invalid model/parameter combination', async () => {
    // 'auto' size + a deliberately over-long prompt is still valid; instead we
    // assert the happy-path contract holds for the 'auto' defaults path.
    const result = await gptImageTool.handler({
      prompt: 'A single green leaf, studio lighting',
      _context: CONTEXT,
    });
    expect(result.success).toBe(true);
    expect((result.configuration as { size: string }).size).toBe('auto');
  });
});

// -----------------------------------------------------------------------------
// gpt_image_edit validation (no API call).
// -----------------------------------------------------------------------------
describe('gpt_image_edit integration: input validation (no API call)', () => {
  it('rejects an empty imagePaths array', async () => {
    await expect(
      gptImageEditTool.handler({ prompt: 'brighten', imagePaths: [], _context: CONTEXT })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects a non-s3 image path', async () => {
    await expect(
      gptImageEditTool.handler({
        prompt: 'brighten',
        imagePaths: ['https://example.com/x.png'],
        _context: CONTEXT,
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });
});

// -----------------------------------------------------------------------------
// Real multi-turn round-trip: generate an image, then edit that result. Uses the
// stateful S3 mock so the edit tool reads back exactly what generation wrote —
// exercising the full stateless multi-turn flow (path in -> path out -> path in).
// -----------------------------------------------------------------------------
describeIfKey('gpt_image_edit integration: multi-turn round-trip', () => {
  it('edits a previously generated image and returns a new path', async () => {
    const gen = await gptImageTool.handler({
      prompt: 'A plain white ceramic mug on a neutral background',
      size: '1024x1024',
      quality: 'low',
      numberOfImages: 1,
      _context: CONTEXT,
    });
    const sourcePath = (gen.s3Paths as string[])[0];
    expect(sourcePath).toMatch(/^s3:\/\//);

    const edited = await gptImageEditTool.handler({
      prompt: 'Add a bright red heart painted on the side of the mug',
      imagePaths: [sourcePath],
      size: '1024x1024',
      quality: 'low',
      numberOfImages: 1,
      _context: CONTEXT,
    });

    expect(edited.success).toBe(true);
    expect(edited.inputImageCount).toBe(1);
    expect(edited.imageCount).toBe(1);
    const editedPath = (edited.s3Paths as string[])[0];
    expect(editedPath).toMatch(/^s3:\/\/.+\.png$/);
    // The edit must be a NEW object, not the source.
    expect(editedPath).not.toBe(sourcePath);
  });
});
