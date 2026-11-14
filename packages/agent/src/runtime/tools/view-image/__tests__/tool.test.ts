/**
 * view_image, exercised through the SDK's tool-result wrapping: the model must
 * receive a real image block, not a description or a serialised blob.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import type { ImageBlock, LocalAgent, TextBlock, ToolResultBlock } from '@strands-agents/sdk';
import type { UserId } from '@moca/core';
import type { RequestContext } from '../../../../libs/context/request-context.js';
import type { IWorkspaceSync } from '../../../../types/index.js';

jest.unstable_mockModule('../../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { createRequestContext, runWithContext } =
  await import('../../../../libs/context/request-context.js');
const { viewImageTool } = await import('../tool.js');

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'view-image-'));
  await writeFile(
    join(workDir, 'small.png'),
    await sharp({ create: { width: 320, height: 200, channels: 3, background: '#336699' } })
      .png()
      .toBuffer()
  );
  await writeFile(
    join(workDir, 'large.png'),
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#336699' } })
      .png()
      .toBuffer()
  );
  await writeFile(join(workDir, 'notes.txt'), 'not an image');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    ...createRequestContext(),
    userId: 'user-sub' as UserId,
    workspaceSync: {
      waitForInitialSync: async () => {},
      getActiveWorkingDirectory: () => workDir,
    } as unknown as IWorkspaceSync,
    ...overrides,
  };
}

async function view(input: unknown, ctx: RequestContext = context()): Promise<ToolResultBlock> {
  return runWithContext(ctx, async () => {
    const stream = viewImageTool.stream({
      toolUse: { name: 'view_image', toolUseId: 'tool-1', input: input as never },
      agent: {} as LocalAgent,
      invocationState: {},
      cancelSignal: new AbortController().signal,
    });
    let step = await stream.next();
    while (!step.done) step = await stream.next();
    return step.value;
  });
}

describe('view_image', () => {
  it('returns the image itself alongside a text summary', async () => {
    const result = await view({ imagePath: join(workDir, 'small.png') });

    expect(result.status).toBe('success');
    expect(result.content.map((block) => block.type)).toEqual(['textBlock', 'imageBlock']);

    const image = result.content[1] as ImageBlock;
    expect(image.format).toBe('png');
    if (image.source.type !== 'imageSourceBytes') throw new Error('expected a bytes source');
    const decoded = await sharp(Buffer.from(image.source.bytes)).metadata();
    expect([decoded.width, decoded.height]).toEqual([320, 200]);

    const text = (result.content[0] as TextBlock).text;
    expect(text).toContain('Original: 320x200 png');
    expect(text).toContain('Shown: 320x200 png');
    expect(text).not.toContain('region');
  });

  it('tells the model how a downscaled image relates to the original', async () => {
    const result = await view({ imagePath: join(workDir, 'large.png') });

    const text = (result.content[0] as TextBlock).text;
    expect(text).toContain('Original: 3000x2000 png');
    expect(text).toContain('Shown: 1568x1045 png (scaled to 52%)');
    expect(text).toContain('`region`');
  });

  it('shows a requested region at full resolution', async () => {
    const result = await view({
      imagePath: join(workDir, 'large.png'),
      region: { x: 1000, y: 500, width: 400, height: 300 },
    });

    const text = (result.content[0] as TextBlock).text;
    expect(text).toContain('Region: x=1000, y=500, 400x300');
    expect(text).toContain('Shown: 400x300 png');
    expect(text).not.toContain('scaled to');
  });

  it('resolves a relative path against the active working directory', async () => {
    const result = await view({ imagePath: 'small.png' });

    expect(result.status).toBe('success');
  });

  it('waits for the workspace sync before reading the file', async () => {
    const lateFile = join(workDir, 'late.png');
    const ctx = context({
      workspaceSync: {
        waitForInitialSync: async () => {
          await writeFile(
            lateFile,
            await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } })
              .png()
              .toBuffer()
          );
        },
        getActiveWorkingDirectory: () => workDir,
      } as unknown as IWorkspaceSync,
    });

    const result = await view({ imagePath: lateFile }, ctx);

    expect(result.status).toBe('success');
  });

  it.each([
    ['a missing file', 'missing.png', 'ENOENT'],
    ['a file that is not an image', 'notes.txt', 'Unsupported image format'],
  ])('reports %s as a tool error', async (_label, file, message) => {
    const result = await view({ imagePath: join(workDir, file) });

    expect(result.status).toBe('error');
    expect((result.content[0] as TextBlock).text).toContain(message);
  });

  it('reports an out-of-bounds region as a tool error', async () => {
    const result = await view({
      imagePath: join(workDir, 'small.png'),
      region: { x: 500, y: 0, width: 10, height: 10 },
    });

    expect(result.status).toBe('error');
    expect((result.content[0] as TextBlock).text).toContain('320x200');
  });

  it('refuses to run without an authenticated user', async () => {
    const result = await view(
      { imagePath: join(workDir, 'small.png') },
      context({ userId: undefined })
    );

    expect(result.status).toBe('error');
  });
});
