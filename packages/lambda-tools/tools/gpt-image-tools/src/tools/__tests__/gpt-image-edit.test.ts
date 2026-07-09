// Stub S3 and the OpenAI API call so validation tests never touch network/AWS.
// These mocks are only reached if validation passes; the assertions below all
// target the pre-network validation guards.
jest.mock('../s3-io.js', () => ({
  readS3Object: jest.fn(async () => Buffer.from('fake')),
  saveImageToS3: jest.fn(async () => 's3://bucket/users/id/out.png'),
}));
jest.mock('../gpt-image-common.js', () => ({
  callOpenAiImageEditApi: jest.fn(async () => ({ created: 0, data: [{ b64_json: 'AAAA' }] })),
}));

import { ToolValidationError } from '@moca/lambda-tools-shared';
import { gptImageEditTool } from '../gpt-image-edit.js';

const CONTEXT = { identityId: 'us-east-1:test', storagePath: '/generated' };

describe('gpt_image_edit: input validation (no network)', () => {
  it('rejects a missing prompt', async () => {
    await expect(
      gptImageEditTool.handler({ imagePaths: ['s3://b/k.png'], _context: CONTEXT })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects an empty imagePaths array', async () => {
    await expect(
      gptImageEditTool.handler({ prompt: 'brighten', imagePaths: [], _context: CONTEXT })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects more than four input images', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => `s3://b/${n}.png`);
    await expect(
      gptImageEditTool.handler({ prompt: 'compose', imagePaths: many, _context: CONTEXT })
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

  it('rejects a non-s3 mask path', async () => {
    await expect(
      gptImageEditTool.handler({
        prompt: 'brighten',
        imagePaths: ['s3://b/k.png'],
        maskPath: '/local/mask.png',
        _context: CONTEXT,
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects an invalid size', async () => {
    await expect(
      gptImageEditTool.handler({
        prompt: 'brighten',
        imagePaths: ['s3://b/k.png'],
        size: '999x999',
        _context: CONTEXT,
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('rejects when user context (identityId) is missing', async () => {
    await expect(
      gptImageEditTool.handler({ prompt: 'brighten', imagePaths: ['s3://b/k.png'] })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('succeeds and returns a result path for valid input', async () => {
    const result = await gptImageEditTool.handler({
      prompt: 'make the sky purple',
      imagePaths: ['s3://bucket/users/id/prev.png'],
      _context: CONTEXT,
    });
    expect(result.success).toBe(true);
    expect(result.inputImageCount).toBe(1);
    expect((result.s3Paths as string[]).length).toBe(1);
  });
});
