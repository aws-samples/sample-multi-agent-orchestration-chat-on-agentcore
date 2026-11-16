/**
 * Workspace sync after credentials can no longer be refreshed (AC-3): skip
 * the push (which would fail once per file) and surface it once per turn.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const pushMock = jest.fn<() => Promise<unknown>>();
const canObtainMock = jest.fn<() => boolean>();
const reportMock = jest.fn<(target: string, error: unknown) => boolean>().mockReturnValue(true);

jest.unstable_mockModule('../../config/index.js', () => ({
  config: { IDENTITY_POOL_ID: 'pool', USER_STORAGE_BUCKET_NAME: 'b', AWS_REGION: 'r' },
  WORKSPACE_DIRECTORY: '/tmp/ws-test',
  SHARED_SKILLS_DIRECTORY: '/tmp/ws-shared-test',
  SKILLS_DIR_NAME: '.agents/skills',
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.unstable_mockModule('@moca/s3-workspace-sync', () => ({
  S3WorkspaceSync: class {
    push = pushMock;
  },
}));
jest.unstable_mockModule('../../libs/utils/scoped-credentials.js', () => ({
  createUserScopedS3Client: async () => ({}),
  getIdentityId: async () => 'ap-northeast-1:11111111-2222-3333-4444-555555555555',
  canObtainUserScopedCredentials: canObtainMock,
  UserCredentialsExpiredError: class extends Error {
    name = 'UserCredentialsExpiredError';
  },
}));
jest.unstable_mockModule('../session/persistence-health.js', () => ({
  reportPersistenceFailure: reportMock,
  isCredentialExpiryError: (e: unknown) => String(e).includes('ExpiredToken'),
}));

const { WorkspaceSync } = await import('../workspace-sync.js');
const { isBusy, resetInFlight } = await import('../../libs/health/in-flight.js');

beforeEach(() => {
  jest.clearAllMocks();
  resetInFlight();
  pushMock.mockResolvedValue({ success: true, uploadedFiles: 1 });
});

describe('WorkspaceSync.syncToS3 with expired credentials', () => {
  it('does not push when user-scoped credentials cannot be obtained, and reports it', async () => {
    canObtainMock.mockReturnValue(false);
    const sync = new WorkspaceSync('user', '/');

    const result = await sync.syncToS3();

    expect(pushMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(reportMock).toHaveBeenCalledWith('workspace', expect.anything());
  });

  it('reports per-file expiry errors from a push once, through persistence-health', async () => {
    canObtainMock.mockReturnValue(true);
    pushMock.mockResolvedValue({
      success: false,
      errors: ['Failed to upload a: ExpiredToken', 'Failed to upload b: ExpiredToken'],
    });
    const sync = new WorkspaceSync('user', '/');

    await sync.syncToS3();

    expect(reportMock).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceSync.syncToS3 as a flush', () => {
  beforeEach(() => canObtainMock.mockReturnValue(true));

  it('serializes pushes, so awaiting one waits for the earlier fire-and-forget push', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    pushMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => {
              order.push('first');
              resolve({ success: true });
            };
          })
      )
      .mockImplementationOnce(async () => {
        order.push('second');
        return { success: true };
      });
    const sync = new WorkspaceSync('user', '/');

    void sync.syncToS3();
    const flushed = sync.syncToS3();
    await new Promise((r) => setTimeout(r, 0));
    expect(pushMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await flushed;
    expect(order).toEqual(['first', 'second']);
  });

  it('keeps the container busy while a push runs, even after it fails', async () => {
    let rejectPush!: (e: Error) => void;
    pushMock.mockImplementationOnce(() => new Promise((_, reject) => (rejectPush = reject)));
    const sync = new WorkspaceSync('user', '/');

    const pending = sync.syncToS3();
    expect(isBusy()).toBe(true);

    await new Promise((r) => setTimeout(r, 0));
    rejectPush(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0));
    expect(isBusy()).toBe(false);

    pushMock.mockResolvedValueOnce({ success: true });
    await expect(sync.syncToS3()).resolves.toMatchObject({ success: true });
  });
});
