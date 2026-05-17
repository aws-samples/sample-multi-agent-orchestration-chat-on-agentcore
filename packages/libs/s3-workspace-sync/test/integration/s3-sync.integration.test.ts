/**
 * S3WorkspaceSync Integration Tests
 * Tests file synchronization with an actual S3 connection.
 *
 * Prerequisites:
 *   - AWS credentials configured
 *   - USER_STORAGE_BUCKET_NAME environment variable set
 *
 * Run:
 *   cd packages/shared/s3-workspace-sync
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { S3WorkspaceSync } from '../../src/s3-workspace-sync.js';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BUCKET_NAME = process.env.USER_STORAGE_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const TEST_PREFIX = `integration-test-${Date.now()}/`;

if (!BUCKET_NAME) {
  console.warn(
    'Skipping integration tests: USER_STORAGE_BUCKET_NAME environment variable is required'
  );
}

const describeIntegration = BUCKET_NAME ? describe : describe.skip;

describeIntegration('S3WorkspaceSync Integration Tests', () => {
  let s3Client: S3Client;
  let testWorkspaceDir: string;

  beforeAll(() => {
    s3Client = new S3Client({ region: AWS_REGION });
    console.log('Integration Test Setup:');
    console.log(`  Bucket: ${BUCKET_NAME}`);
    console.log(`  Region: ${AWS_REGION}`);
    console.log(`  Prefix: ${TEST_PREFIX}`);
  });

  beforeEach(() => {
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-sync-int-test-'));
    console.log(`  Workspace: ${testWorkspaceDir}`);
  });

  afterEach(async () => {
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
    await cleanupS3TestFiles();
  });

  async function cleanupS3TestFiles(): Promise<void> {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: BUCKET_NAME!,
        Prefix: TEST_PREFIX,
      });
      const response = await s3Client.send(listCommand);

      if (response.Contents && response.Contents.length > 0) {
        for (const item of response.Contents) {
          if (item.Key) {
            await s3Client.send(
              new DeleteObjectCommand({ Bucket: BUCKET_NAME!, Key: item.Key })
            );
          }
        }
        console.log(`  Cleaned up ${response.Contents.length} test files from S3`);
      }
    } catch (error) {
      console.error('Failed to cleanup S3 test files:', error);
    }
  }

  async function uploadTestFile(fileName: string, content: string): Promise<void> {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME!,
        Key: `${TEST_PREFIX}${fileName}`,
        Body: content,
        ContentType: 'text/plain',
      })
    );
  }

  it('pull: downloads files from S3', async () => {
    await uploadTestFile('test.txt', 'Hello from S3!');

    const sync = new S3WorkspaceSync({
      bucket: BUCKET_NAME!,
      prefix: TEST_PREFIX,
      workspaceDir: testWorkspaceDir,
      s3Client,
    });

    const result = await sync.pull();

    expect(result.success).toBe(true);
    expect(result.downloadedFiles).toBe(1);
    expect(fs.readFileSync(path.join(testWorkspaceDir, 'test.txt'), 'utf-8')).toBe(
      'Hello from S3!'
    );
  });

  it('push: uploads new files to S3', async () => {
    const sync = new S3WorkspaceSync({
      bucket: BUCKET_NAME!,
      prefix: TEST_PREFIX,
      workspaceDir: testWorkspaceDir,
      s3Client,
    });

    await sync.pull();

    fs.writeFileSync(path.join(testWorkspaceDir, 'local-file.txt'), 'Created locally');

    const result = await sync.push();

    expect(result.success).toBe(true);
    expect(result.uploadedFiles).toBe(1);
  });

  it('round-trip: pull → modify → push → pull', async () => {
    await uploadTestFile('round-trip.txt', 'original');

    const sync = new S3WorkspaceSync({
      bucket: BUCKET_NAME!,
      prefix: TEST_PREFIX,
      workspaceDir: testWorkspaceDir,
      s3Client,
    });

    await sync.pull();
    expect(fs.readFileSync(path.join(testWorkspaceDir, 'round-trip.txt'), 'utf-8')).toBe(
      'original'
    );

    fs.writeFileSync(path.join(testWorkspaceDir, 'round-trip.txt'), 'modified');
    await sync.push();

    // Verify by pulling into a fresh workspace
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-sync-int-test-fresh-'));
    try {
      const sync2 = new S3WorkspaceSync({
        bucket: BUCKET_NAME!,
        prefix: TEST_PREFIX,
        workspaceDir: freshDir,
        s3Client,
      });
      await sync2.pull();
      expect(fs.readFileSync(path.join(freshDir, 'round-trip.txt'), 'utf-8')).toBe('modified');
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('background pull: startBackgroundPull + waitForPull', async () => {
    await uploadTestFile('bg.txt', 'background sync');

    const sync = new S3WorkspaceSync({
      bucket: BUCKET_NAME!,
      prefix: TEST_PREFIX,
      workspaceDir: testWorkspaceDir,
      s3Client,
    });

    sync.startBackgroundPull();
    expect(sync.isPullComplete()).toBe(false);
    await sync.waitForPull();
    expect(sync.isPullComplete()).toBe(true);

    expect(fs.readFileSync(path.join(testWorkspaceDir, 'bg.txt'), 'utf-8')).toBe(
      'background sync'
    );
  });
});
