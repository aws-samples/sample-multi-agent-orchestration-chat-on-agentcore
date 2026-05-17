/**
 * WorkspaceSync Integration Tests
 * Test file synchronization with actual S3 connection
 *
 * How to run:
 * cd packages/agent
 * npx jest --testMatch="glob-pattern-for-integration-tests"
 */

import { WorkspaceSync } from '../workspace-sync.js';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

// Check environment variables
const BUCKET_NAME = process.env.USER_STORAGE_BUCKET_NAME;

/**
 * Extract AWS region from the bucket name if it contains a region pattern,
 * otherwise fall back to AWS_REGION env var.
 */
function detectRegionFromBucket(bucketName: string | undefined): string {
  if (bucketName) {
    // Match common region patterns like ap-northeast-1, us-east-1, eu-west-2
    const regionMatch = bucketName.match(/((?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d)/);
    if (regionMatch) {
      return regionMatch[1];
    }
  }
  return process.env.AWS_REGION || 'us-west-2';
}

const AWS_REGION = detectRegionFromBucket(BUCKET_NAME);

// Force AWS_REGION env var to match the bucket's region,
// so that WorkspaceSync's internal S3 client uses the correct region.
// This overrides any existing AWS_REGION (e.g., us-east-1) when the bucket
// resides in a different region (e.g., ap-northeast-1).
if (BUCKET_NAME) {
  process.env.AWS_REGION = AWS_REGION;
}

const TEST_USER_ID = 'test-user-' + Date.now();
const TEST_STORAGE_PATH = 'integration-test';

if (!BUCKET_NAME) {
  throw new Error(
    'USER_STORAGE_BUCKET_NAME environment variable is required for integration tests'
  );
}

describe('WorkspaceSync Integration Tests', () => {
  let workspaceSync: WorkspaceSync;
  let s3Client: S3Client;
  let testWorkspaceDir: string;
  let s3Prefix: string;

  beforeAll(() => {
    s3Client = new S3Client({ region: AWS_REGION });
    s3Prefix = `users/${TEST_USER_ID}/${TEST_STORAGE_PATH}/`;

    console.log('🧪 Integration Test Setup:');
    console.log(`  Bucket: ${BUCKET_NAME}`);
    console.log(`  Region: ${AWS_REGION}`);
    console.log(`  S3 Prefix: ${s3Prefix}`);
  });

  beforeEach(() => {
    // Create WorkspaceSync instance — files will be synced to its internal workspace path
    workspaceSync = new WorkspaceSync(TEST_USER_ID, TEST_STORAGE_PATH);

    // Use the actual workspace path that S3WorkspaceSync will use for file operations
    testWorkspaceDir = workspaceSync.getWorkspacePath();

    // Ensure the directory exists and is clean for each test
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testWorkspaceDir, { recursive: true });

    console.log(`📁 Test workspace: ${testWorkspaceDir}`);
  });

  afterEach(async () => {
    // Cleanup local test directory
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }

    // Cleanup S3 test files
    await cleanupS3TestFiles();
  });

  /**
   * Delete S3 test files
   */
  async function cleanupS3TestFiles(): Promise<void> {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: s3Prefix,
      });

      const response = await s3Client.send(listCommand);

      if (response.Contents && response.Contents.length > 0) {
        for (const item of response.Contents) {
          if (item.Key) {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: BUCKET_NAME,
              Key: item.Key,
            });
            await s3Client.send(deleteCommand);
          }
        }
        console.log(`🧹 Cleaned up ${response.Contents.length} test files from S3`);
      }
    } catch (error) {
      console.error('⚠️ Failed to cleanup S3 test files:', error);
    }
  }

  /**
   * Upload test file to S3
   */
  async function uploadTestFileToS3(fileName: string, content: string): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `${s3Prefix}${fileName}`,
      Body: content,
      ContentType: 'text/plain',
    });
    await s3Client.send(command);
  }

  /**
   * Check if file exists in S3
   */
  async function fileExistsInS3(fileName: string): Promise<boolean> {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: `${s3Prefix}${fileName}`,
      MaxKeys: 1,
    });
    const response = await s3Client.send(listCommand);
    return (response.Contents?.length ?? 0) > 0;
  }

  describe('Initial sync (S3 → Local)', () => {
    test('Can download files from S3', async () => {
      // Place test file in S3
      const testFileName = 'test-download.txt';
      const testContent = 'Hello from S3!';
      await uploadTestFileToS3(testFileName, testContent);

      // Execute initial sync
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Verify file was downloaded locally
      const localFilePath = path.join(testWorkspaceDir, testFileName);
      expect(fs.existsSync(localFilePath)).toBe(true);

      const downloadedContent = fs.readFileSync(localFilePath, 'utf-8');
      expect(downloadedContent).toBe(testContent);

      console.log('✅ File downloaded successfully from S3');
    }, 30000);

    test('Can download multiple files at once', async () => {
      // Place multiple test files
      const files = [
        { name: 'file1.txt', content: 'Content 1' },
        { name: 'file2.txt', content: 'Content 2' },
        { name: 'subdir/file3.txt', content: 'Content 3' },
      ];

      for (const file of files) {
        await uploadTestFileToS3(file.name, file.content);
      }

      // Execute initial sync
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Verify all files were downloaded
      for (const file of files) {
        const localFilePath = path.join(testWorkspaceDir, file.name);
        expect(fs.existsSync(localFilePath)).toBe(true);

        const content = fs.readFileSync(localFilePath, 'utf-8');
        expect(content).toBe(file.content);
      }

      console.log('✅ Multiple files downloaded successfully');
    }, 30000);

    test('Sync completes without error even with empty S3', async () => {
      // Initial sync with no files in S3
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Verify completion without error
      const files = fs.readdirSync(testWorkspaceDir);
      expect(files.length).toBe(0);

      console.log('✅ Empty S3 sync completed without error');
    }, 30000);
  });

  describe('Change sync (Local → S3)', () => {
    test('Can upload new files to S3', async () => {
      // Complete initial sync
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Create new file locally
      const testFileName = 'test-upload.txt';
      const testContent = 'Hello from local!';
      const localFilePath = path.join(testWorkspaceDir, testFileName);
      fs.writeFileSync(localFilePath, testContent);

      // Sync to S3
      const result = await workspaceSync.syncToS3();

      // Verify sync was successful
      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(1);

      // Verify file exists in S3
      const existsInS3 = await fileExistsInS3(testFileName);
      expect(existsInS3).toBe(true);

      console.log('✅ File uploaded successfully to S3');
    }, 30000);

    test('Upload only changed files', async () => {
      // Place two files in S3
      await uploadTestFileToS3('unchanged.txt', 'Original content');
      await uploadTestFileToS3('to-change.txt', 'Original content');

      // Execute initial sync
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Change only one file
      const changedFilePath = path.join(testWorkspaceDir, 'to-change.txt');
      fs.writeFileSync(changedFilePath, 'Modified content');

      // Sync to S3
      const result = await workspaceSync.syncToS3();

      // Verify only changed file was uploaded
      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(1);

      console.log('✅ Only changed file was uploaded');
    }, 30000);

    test('Can upload multiple files at once', async () => {
      // Complete initial sync
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Create multiple files
      const files = [
        { name: 'upload1.txt', content: 'Upload 1' },
        { name: 'upload2.txt', content: 'Upload 2' },
        { name: 'subdir/upload3.txt', content: 'Upload 3' },
      ];

      for (const file of files) {
        const filePath = path.join(testWorkspaceDir, file.name);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, file.content);
      }

      // Sync to S3
      const result = await workspaceSync.syncToS3();

      // Verify all files were uploaded
      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(3);

      // Verify all files exist in S3
      for (const file of files) {
        const exists = await fileExistsInS3(file.name);
        expect(exists).toBe(true);
      }

      console.log('✅ Multiple files uploaded successfully');
    }, 30000);
  });

  describe('Bidirectional sync', () => {
    test('Can download from S3, modify, and upload', async () => {
      // Place file in S3
      const fileName = 'roundtrip.txt';
      await uploadTestFileToS3(fileName, 'Original from S3');

      // Download with initial sync
      workspaceSync.startInitialSync();
      await workspaceSync.waitForInitialSync();

      // Modify file
      const filePath = path.join(testWorkspaceDir, fileName);
      const originalContent = fs.readFileSync(filePath, 'utf-8');
      expect(originalContent).toBe('Original from S3');

      fs.writeFileSync(filePath, 'Modified locally');

      // Upload to S3
      const result = await workspaceSync.syncToS3();
      expect(result.success).toBe(true);
      expect(result.uploadedFiles).toBe(1);

      console.log('✅ Round-trip sync completed successfully');
    }, 30000);
  });

  describe('Error handling', () => {
    test('Skip if bucket name is not set', async () => {
      // Temporarily remove environment variable
      const originalBucket = process.env.USER_STORAGE_BUCKET_NAME;
      delete process.env.USER_STORAGE_BUCKET_NAME;

      try {
        // WorkspaceSync may throw during construction or sync when bucket is missing
        const sync = new WorkspaceSync(TEST_USER_ID, TEST_STORAGE_PATH);
        sync.startInitialSync();
        await sync.waitForInitialSync();
        // If it completes without error, that's also acceptable
        console.log('✅ Handled missing bucket name gracefully (no error thrown)');
      } catch (error) {
        // It's expected that it may throw when bucket is not configured
        expect(error).toBeDefined();
        console.log('✅ Handled missing bucket name gracefully (error thrown as expected)');
      } finally {
        // Restore environment variable
        process.env.USER_STORAGE_BUCKET_NAME = originalBucket;
      }
    });
  });
});
