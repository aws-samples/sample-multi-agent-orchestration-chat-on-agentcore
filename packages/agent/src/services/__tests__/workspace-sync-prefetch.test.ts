/**
 * Unit tests for the per-(user, storagePath) WorkspaceSync cache and warmup prefetch
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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

// Each test uses its own storagePath so cached syncs never leak across tests.
let n = 0;
const uniquePath = () => `/project-${++n}`;

describe('workspace sync cache', () => {
  let now = 1_000_000;

  beforeEach(() => {
    instances.length = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuses one sync across warmup and invocations, re-pulling each time', async () => {
    const p = uniquePath();
    await prefetchWorkspaceSync(USER, p);
    const first = initializeWorkspaceSync(USER, `${p}/`);
    const second = initializeWorkspaceSync(USER, p);

    expect(instances).toHaveLength(1);
    expect(first.workspaceSync).toBe(instances[0]);
    expect(second.workspaceSync).toBe(instances[0]);
    // Every acquisition triggers a (diff-only) pull to pick up S3 changes.
    expect(instances[0].startInitialSync).toHaveBeenCalledTimes(3);
  });

  it('is not shared across users or storage paths', () => {
    const p = uniquePath();
    initializeWorkspaceSync(USER, p);
    initializeWorkspaceSync(OTHER_USER, p);
    initializeWorkspaceSync(USER, uniquePath());

    expect(instances).toHaveLength(3);
  });

  it('rebuilds the sync once it is older than the credential-safe max age', () => {
    const p = uniquePath();
    initializeWorkspaceSync(USER, p);
    now += 30 * 60 * 1000;

    const { workspaceSync } = initializeWorkspaceSync(USER, p);

    expect(workspaceSync).toBe(instances[1]);
  });

  it('drops a sync whose initialization failed so the next call starts fresh', async () => {
    const p = uniquePath();
    nextInitFails = true;

    await expect(prefetchWorkspaceSync(USER, p)).resolves.toBeUndefined();
    const { workspaceSync } = initializeWorkspaceSync(USER, p);

    expect(workspaceSync).toBe(instances[1]);
  });

  it('prefetch rejects invalid storage paths', () => {
    expect(() => prefetchWorkspaceSync(USER, '../escape')).toThrow();
    expect(instances).toHaveLength(0);
  });
});
