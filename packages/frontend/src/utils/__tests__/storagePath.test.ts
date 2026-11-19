import { describe, it, expect } from 'vitest';
import { storageBasename, storageDirname } from '../storagePath';

describe('storagePath', () => {
  it.each([
    ['/kaisei/修正一覧.md', '修正一覧.md', '/kaisei'],
    ['/a/b/c.txt', 'c.txt', '/a/b'],
    ['/root.md', 'root.md', '/'],
  ])('%s → basename %s, dirname %s', (path, base, dir) => {
    expect(storageBasename(path)).toBe(base);
    expect(storageDirname(path)).toBe(dir);
  });
});
