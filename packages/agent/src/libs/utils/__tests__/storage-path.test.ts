import { describe, it, expect } from '@jest/globals';
import { normalizePath, getUserStoragePrefix, buildUserPrefix } from '../storage-path.js';

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
