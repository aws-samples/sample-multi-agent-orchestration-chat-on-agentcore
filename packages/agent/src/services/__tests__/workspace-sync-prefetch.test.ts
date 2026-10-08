/**
 * Unit tests for warmup-time workspace sync prefetch
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { UserId } from '@moca/core';

interface FakeSync {
  startInitialSync: jest.Mock;
  waitForInitialSync: jest.Mock<() => Promise<void>>;
  waitForSharedSkillsSync: jest.Mock<() => Promise<string | null>>;
}

const instances: FakeSync[] = [];
let nextInitFails = false;

jest.unstable_mockModule('../workspace-sync.js', () => ({
  WorkspaceSync: jest.fn().mockImplementation(() => {
    const initFails = nextInitFails;
    nextInitFails = false;
    const instance: FakeSync = {
      startInitialSync: jest.fn(),
      waitForInitialSync: jest
        .fn<() => Promise<void>>()
        .mockImplementation(() =>
          initFails ? Promise.reject(new Error('GetId failed')) : Promise.resolve()
        ),
      waitForSharedSkillsSync: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    };
    instances.push(instance);
    return instance;
  }),
}));
jest.unstable_mockModule('../session/workspace-sync-hook.js', () => ({
  WorkspaceSyncHook: jest.fn(),
}));
jest.unstable_mockModule('../../config/index.js', () => ({
  BUNDLED_SKILLS_DIRECTORY: '/app/skills',
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { prefetchWorkspaceSync, initializeWorkspaceSync } =
  await import('../workspace-sync-helper.js');

const USER = 'user-1' as UserId;
const OTHER_USER = 'user-2' as UserId;

// Each test uses its own storagePath so leftover prefetches never leak across tests.
let n = 0;
const uniquePath = () => `/project-${++n}`;

describe('prefetchWorkspaceSync', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('lets the next invocation reuse the prefetched sync and queue a catch-up pull', async () => {
    const p = uniquePath();
    await prefetchWorkspaceSync(USER, p);
    expect(instances).toHaveLength(1);
    expect(instances[0].startInitialSync).toHaveBeenCalledTimes(1);

    const { workspaceSync } = initializeWorkspaceSync(USER, `${p}/`);

    expect(workspaceSync).toBe(instances[0]);
    expect(instances).toHaveLength(1);
    // Second pull picks up S3 changes made after the warmup (e.g. attached files).
    expect(instances[0].startInitialSync).toHaveBeenCalledTimes(2);
  });

  it('is claimable only once', () => {
    const p = uniquePath();
    void prefetchWorkspaceSync(USER, p);
    initializeWorkspaceSync(USER, p);
    const second = initializeWorkspaceSync(USER, p);

    expect(instances).toHaveLength(2);
    expect(second.workspaceSync).toBe(instances[1]);
  });

  it('dedupes prefetches for the same user and path', () => {
    const p = uniquePath();
    const first = prefetchWorkspaceSync(USER, p);
    const second = prefetchWorkspaceSync(USER, p);

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeUndefined();
    expect(instances).toHaveLength(1);
  });

  it('is not reused for another user or storagePath', () => {
    const p = uniquePath();
    void prefetchWorkspaceSync(USER, p);

    initializeWorkspaceSync(OTHER_USER, p);
    initializeWorkspaceSync(USER, uniquePath());

    expect(instances).toHaveLength(3);
  });

  it('drops a prefetch whose initialization failed so the invocation starts fresh', async () => {
    const p = uniquePath();
    nextInitFails = true;

    await expect(prefetchWorkspaceSync(USER, p)).resolves.toBeUndefined();
    const { workspaceSync } = initializeWorkspaceSync(USER, p);

    expect(workspaceSync).toBe(instances[1]);
  });

  it('rejects invalid storage paths', () => {
    expect(() => prefetchWorkspaceSync(USER, '../escape')).toThrow();
    expect(instances).toHaveLength(0);
  });
});
