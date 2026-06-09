import { describe, it, expect } from '@jest/globals';
import {
  normalizePath,
  getUserStoragePrefix,
  buildUserPrefix,
  safeWorkspaceDir,
} from '../storage-path.js';

describe('normalizePath', () => {
  it('strips leading slashes', () => {
    expect(normalizePath('/a/b')).toBe('a/b');
    expect(normalizePath('///a')).toBe('a');
  });

  it('strips trailing slashes', () => {
    expect(normalizePath('a/b/')).toBe('a/b');
    expect(normalizePath('a///')).toBe('a');
  });

  it('strips both ends', () => {
    expect(normalizePath('/a/b/')).toBe('a/b');
  });

  it('leaves interior slashes untouched', () => {
    expect(normalizePath('a/b/c')).toBe('a/b/c');
  });

  it('returns empty string for root or empty', () => {
    expect(normalizePath('/')).toBe('');
    expect(normalizePath('')).toBe('');
  });
});

describe('getUserStoragePrefix', () => {
  it('builds the per-user prefix', () => {
    expect(getUserStoragePrefix('ap-northeast-1:uuid')).toBe('users/ap-northeast-1:uuid');
  });

  it('does not add a trailing slash', () => {
    expect(getUserStoragePrefix('abc').endsWith('/')).toBe(false);
  });
});

describe('buildUserPrefix', () => {
  // These lock the EXACT S3 key prefix WorkspaceSync produced before the
  // shared-helper refactor. A drift here (missing/doubled slash) would make a
  // tool read from a different prefix than another wrote to.
  it('appends the normalized storage path with a single trailing slash', () => {
    expect(buildUserPrefix('REGION:uuid', 'dev2')).toBe('users/REGION:uuid/dev2/');
  });

  it('omits the path segment when empty, keeping the trailing slash', () => {
    expect(buildUserPrefix('REGION:uuid', '')).toBe('users/REGION:uuid/');
  });

  it('normalizes a path that arrives with leading/trailing slashes', () => {
    expect(buildUserPrefix('k', '/sub/dir/')).toBe('users/k/sub/dir/');
  });

  it('never produces a doubled slash between segments', () => {
    expect(buildUserPrefix('k', 'a')).not.toContain('//');
    expect(buildUserPrefix('k', '')).not.toContain('//');
  });
});

describe('safeWorkspaceDir', () => {
  const BASE = '/tmp/ws';

  it('joins a normal sub-path under the base', () => {
    expect(safeWorkspaceDir(BASE, 'dev2')).toBe('/tmp/ws/dev2');
    expect(safeWorkspaceDir(BASE, 'a/b/c')).toBe('/tmp/ws/a/b/c');
  });

  it('returns the base itself for empty or root paths', () => {
    expect(safeWorkspaceDir(BASE, '')).toBe('/tmp/ws');
    expect(safeWorkspaceDir(BASE, '/')).toBe('/tmp/ws');
  });

  it('strips leading/trailing slashes before joining', () => {
    expect(safeWorkspaceDir(BASE, '/sub/dir/')).toBe('/tmp/ws/sub/dir');
  });

  it('contains traversal: ".." never climbs above the base directory', () => {
    // A leading `..` is dropped (cannot go above BASE); trailing segments stay.
    expect(safeWorkspaceDir(BASE, '../etc')).toBe('/tmp/ws/etc');
    expect(safeWorkspaceDir(BASE, '../../etc/passwd')).toBe('/tmp/ws/etc/passwd');
    // Interior `..` pops within the path but is clamped at BASE.
    expect(safeWorkspaceDir(BASE, 'a/../../b')).toBe('/tmp/ws/b');
    expect(safeWorkspaceDir(BASE, 'sub/../../../escape')).toBe('/tmp/ws/escape');
  });

  it('drops "." segments', () => {
    expect(safeWorkspaceDir(BASE, './a/./b')).toBe('/tmp/ws/a/b');
  });

  it('always stays within the base prefix', () => {
    for (const p of ['..', '../..', '/../x', 'a/../../../../../y', 'foo/bar']) {
      const result = safeWorkspaceDir(BASE, p);
      expect(result === BASE || result.startsWith(BASE + '/')).toBe(true);
    }
  });
});
