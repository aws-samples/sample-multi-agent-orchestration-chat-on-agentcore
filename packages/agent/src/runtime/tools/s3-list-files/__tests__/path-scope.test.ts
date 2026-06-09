import { describe, it, expect } from '@jest/globals';
import { getUserStoragePrefix, isPathWithinAllowedScope, normalizePath } from '../path-scope.js';

describe('normalizePath', () => {
  it('strips leading slashes', () => {
    expect(normalizePath('/foo/bar')).toBe('foo/bar');
  });

  it('strips trailing slashes', () => {
    expect(normalizePath('foo/bar/')).toBe('foo/bar');
  });

  it('strips both leading and trailing slashes', () => {
    expect(normalizePath('///foo/bar///')).toBe('foo/bar');
  });

  it('reduces a bare root to the empty string', () => {
    expect(normalizePath('/')).toBe('');
    expect(normalizePath('')).toBe('');
  });
});

describe('isPathWithinAllowedScope', () => {
  it('allows the exact same path', () => {
    expect(isPathWithinAllowedScope('projects/a', 'projects/a')).toBe(true);
  });

  it('allows a child of the allowed path', () => {
    expect(isPathWithinAllowedScope('projects/a/sub/file', 'projects/a')).toBe(true);
  });

  it('rejects a sibling path', () => {
    expect(isPathWithinAllowedScope('projects/b', 'projects/a')).toBe(false);
  });

  it('rejects a prefix-string sibling that is not a path child', () => {
    // "projects/ab" shares the textual prefix "projects/a" but is a different
    // directory, so it must not pass the boundary check.
    expect(isPathWithinAllowedScope('projects/ab', 'projects/a')).toBe(false);
  });

  it('allows everything when the base path is root', () => {
    expect(isPathWithinAllowedScope('anything/at/all', '/')).toBe(true);
    expect(isPathWithinAllowedScope('anything/at/all', '')).toBe(true);
  });

  it('normalizes slashes before comparing', () => {
    expect(isPathWithinAllowedScope('/projects/a/', '/projects/a')).toBe(true);
  });
});

describe('getUserStoragePrefix', () => {
  it('produces a "users/<id>" prefix', () => {
    expect(getUserStoragePrefix('us-east-1:abc-123')).toBe('users/us-east-1:abc-123');
  });
});
