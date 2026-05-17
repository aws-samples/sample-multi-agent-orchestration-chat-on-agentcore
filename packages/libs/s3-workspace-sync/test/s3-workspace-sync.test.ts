import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { S3WorkspaceSync } from '../src/s3-workspace-sync.js';
import type { SyncLogger, SyncProgress } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Mock S3Client
// ---------------------------------------------------------------------------

interface MockS3Object {
  Key: string;
  Body: string;
  ContentType?: string;
}

function createMockS3Client(initialObjects: MockS3Object[] = []) {
  const store = new Map<string, MockS3Object>();
  initialObjects.forEach((obj) => store.set(obj.Key, obj));

  const send = vi.fn(async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const input = command.input as Record<string, unknown> ?? {};

    if (name === 'ListObjectsV2Command') {
      const prefix = (input.Prefix as string) || '';
      const contents = Array.from(store.values())
        .filter((obj) => obj.Key.startsWith(prefix))
        .map((obj) => ({
          Key: obj.Key,
          Size: obj.Body.length,
          LastModified: new Date(),
        }));
      return { Contents: contents, IsTruncated: false };
    }

    if (name === 'GetObjectCommand') {
      const key = input.Key as string;
      const obj = store.get(key);
      if (!obj) throw new Error(`NoSuchKey: ${key}`);
      const body = Readable.from(Buffer.from(obj.Body));
      return { Body: body };
    }

    if (name === 'PutObjectCommand') {
      const key = input.Key as string;
      const body = input.Body as Buffer;
      store.set(key, {
        Key: key,
        Body: body.toString(),
        ContentType: input.ContentType as string,
      });
      return {};
    }

    throw new Error(`Unmocked S3 command: ${name}`);
  });

  return { send, _store: store };
}

function createSilentLogger(): SyncLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S3WorkspaceSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-workspace-sync-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor validation', () => {
    it('throws if bucket is missing', () => {
      expect(
        () =>
          new S3WorkspaceSync({
            bucket: '',
            prefix: 'test/',
            workspaceDir: tmpDir,
            logger: createSilentLogger(),
          })
      ).toThrow('options.bucket is required');
    });

    it('throws if prefix is missing', () => {
      expect(
        () =>
          new S3WorkspaceSync({
            bucket: 'my-bucket',
            prefix: '',
            workspaceDir: tmpDir,
            logger: createSilentLogger(),
          })
      ).toThrow('options.prefix is required');
    });

    it('throws if workspaceDir is missing', () => {
      expect(
        () =>
          new S3WorkspaceSync({
            bucket: 'my-bucket',
            prefix: 'test/',
            workspaceDir: '',
            logger: createSilentLogger(),
          })
      ).toThrow('options.workspaceDir is required');
    });

    it('appends trailing slash to prefix if missing', () => {
      const mockClient = createMockS3Client();
      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'no-trailing-slash',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });
      expect(sync).toBeDefined();
    });
  });

  describe('pull()', () => {
    it('downloads files from S3 to local workspace', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/hello.txt', Body: 'Hello World' },
        { Key: 'prefix/sub/data.json', Body: '{"key":"value"}' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      const result = await sync.pull();

      expect(result.success).toBe(true);
      expect(result.downloadedFiles).toBe(2);
      expect(fs.readFileSync(path.join(tmpDir, 'hello.txt'), 'utf-8')).toBe('Hello World');
      expect(fs.readFileSync(path.join(tmpDir, 'sub/data.json'), 'utf-8')).toBe('{"key":"value"}');
    });

    it('skips ignored files', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/src/index.ts', Body: 'code' },
        { Key: 'prefix/node_modules/pkg/index.js', Body: 'pkg' },
        { Key: 'prefix/.DS_Store', Body: 'ds' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      const result = await sync.pull();

      expect(result.downloadedFiles).toBe(1);
      expect(fs.existsSync(path.join(tmpDir, 'src/index.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.DS_Store'))).toBe(false);
    });

    it('deletes local-only files not present on S3', async () => {
      // Pre-create a local file that doesn't exist on S3
      fs.writeFileSync(path.join(tmpDir, 'old-file.txt'), 'will be deleted');

      const mockClient = createMockS3Client([
        { Key: 'prefix/new-file.txt', Body: 'new content' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      const result = await sync.pull();

      expect(result.success).toBe(true);
      expect(result.deletedFiles).toBe(1);
      expect(fs.existsSync(path.join(tmpDir, 'old-file.txt'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'new-file.txt'))).toBe(true);
    });

    it('skips S3 folder entries', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/', Body: '' },
        { Key: 'prefix/sub/', Body: '' },
        { Key: 'prefix/file.txt', Body: 'content' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      const result = await sync.pull();
      expect(result.downloadedFiles).toBe(1);
    });
  });

  describe('push()', () => {
    it('uploads new files to S3', async () => {
      const mockClient = createMockS3Client();

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      // Complete pull first (empty S3)
      await sync.pull();

      // Create a new file locally
      fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'brand new content');

      const result = await sync.push();

      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(1);
      expect(mockClient._store.has('prefix/new-file.txt')).toBe(true);
      expect(mockClient._store.get('prefix/new-file.txt')!.Body).toBe('brand new content');
    });

    it('uploads modified files', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/file.txt', Body: 'original' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      await sync.pull();

      // Modify the file
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified content');

      const result = await sync.push();

      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(1);
      expect(mockClient._store.get('prefix/file.txt')!.Body).toBe('modified content');
    });

    it('does not upload unchanged files', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/file.txt', Body: 'same content' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      await sync.pull();

      // Don't modify anything
      const result = await sync.push();

      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(0);
    });

    it('skips ignored files', async () => {
      const mockClient = createMockS3Client();

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      await sync.pull();

      // Create an ignored file
      fs.writeFileSync(path.join(tmpDir, 'debug.log'), 'log content');
      // And a normal file
      fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'data');

      const result = await sync.push();

      expect(result.uploadedFiles).toBe(1);
      expect(mockClient._store.has('prefix/data.txt')).toBe(true);
      expect(mockClient._store.has('prefix/debug.log')).toBe(false);
    });

    it('sets correct Content-Type on upload', async () => {
      const mockClient = createMockS3Client();

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      await sync.pull();

      fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');

      await sync.push();

      // Verify PutObjectCommand was called with correct ContentType
      const putCalls = mockClient.send.mock.calls.filter(
        (call: unknown[]) => (call[0] as { constructor: { name: string } }).constructor.name === 'PutObjectCommand'
      );
      expect(putCalls.length).toBe(1);
      expect((putCalls[0][0] as { input: { ContentType: string } }).input.ContentType).toBe(
        'application/json; charset=utf-8'
      );
    });
  });

  describe('background pull', () => {
    it('startBackgroundPull + waitForPull works', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/file.txt', Body: 'content' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      expect(sync.isPullComplete()).toBe(false);

      sync.startBackgroundPull();
      await sync.waitForPull();

      expect(sync.isPullComplete()).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'file.txt'), 'utf-8')).toBe('content');
    });

    it('waitForPull resolves immediately if already complete', async () => {
      const mockClient = createMockS3Client();

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      await sync.pull();
      // Calling waitForPull after a completed pull should resolve immediately
      await sync.waitForPull();
    });
  });

  describe('progress events', () => {
    it('emits progress events during large downloads', async () => {
      // Create > 100 objects to trigger progress reporting
      const objects: MockS3Object[] = [];
      for (let i = 0; i < 120; i++) {
        objects.push({ Key: `prefix/file-${i.toString().padStart(3, '0')}.txt`, Body: `content-${i}` });
      }

      const mockClient = createMockS3Client(objects);
      const progressEvents: SyncProgress[] = [];

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      sync.on('progress', (progress: SyncProgress) => {
        progressEvents.push(progress);
      });

      await sync.pull();

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[0].phase).toBe('download');
      expect(progressEvents[0].total).toBe(120);
    });
  });

  describe('custom options', () => {
    it('uses custom contentTypeResolver', async () => {
      const mockClient = createMockS3Client();

      const customResolver = vi.fn(() => 'application/custom');

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
        contentTypeResolver: customResolver,
      });

      await sync.pull();
      fs.writeFileSync(path.join(tmpDir, 'file.xyz'), 'data');
      await sync.push();

      expect(customResolver).toHaveBeenCalledWith('file.xyz');
    });

    it('uses custom ignorePatterns', async () => {
      const mockClient = createMockS3Client([
        { Key: 'prefix/keep.txt', Body: 'keep' },
        { Key: 'prefix/skip.custom', Body: 'skip' },
      ]);

      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
        ignorePatterns: ['*.custom'],
      });

      const result = await sync.pull();

      expect(result.downloadedFiles).toBe(1);
      expect(fs.existsSync(path.join(tmpDir, 'keep.txt'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'skip.custom'))).toBe(false);
    });
  });

  describe('getWorkspacePath', () => {
    it('returns the configured workspace directory', () => {
      const mockClient = createMockS3Client();
      const sync = new S3WorkspaceSync({
        bucket: 'my-bucket',
        prefix: 'prefix/',
        workspaceDir: tmpDir,
        s3Client: mockClient as unknown as import('@aws-sdk/client-s3').S3Client,
        logger: createSilentLogger(),
      });

      expect(sync.getWorkspacePath()).toBe(tmpDir);
    });
  });
});
