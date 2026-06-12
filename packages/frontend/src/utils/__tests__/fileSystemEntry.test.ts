import { describe, it, expect } from 'vitest';
import {
  readDroppedEntries,
  collectDropEntries,
  resolveDirectoryCreation,
  type DroppedEntry,
} from '../fileSystemEntry';

/**
 * The drag-and-drop traversal: collectDropEntries reads the DataTransferItemList
 * synchronously (it is invalidated after the drop tick); readDroppedEntries then
 * walks those entries into uploadable files + empty-directory paths;
 * resolveDirectoryCreation computes where each empty dir is created. All three
 * are unit-tested here against hand-built fakes (no real DOM).
 */

type Fake = FileSystemEntry;

function fileEntry(name: string, contents = 'x'): Fake {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (f: File) => void) => resolve(new File([contents], name)),
  } as unknown as Fake;
}

/** A directory whose children are produced by readEntries in a single batch. */
function dirEntry(name: string, children: Fake[]): Fake {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (resolve: (entries: Fake[]) => void) => resolve(children),
    }),
  } as unknown as Fake;
}

const rels = (entries: DroppedEntry[]) => entries.map((e) => e.relativePath).sort();

describe('readDroppedEntries', () => {
  it('returns a single top-level file with its name as relative path', async () => {
    const { files, directories } = await readDroppedEntries([fileEntry('a.txt')]);
    expect(rels(files)).toEqual(['a.txt']);
    expect(files[0].file).toBeInstanceOf(File);
    expect(directories).toEqual([]);
  });

  it('uses the resolved File.name for top-level files (not entry.name)', async () => {
    // entry.name is 'entry-name' but the resolved File is named 'real.txt';
    // the top-level branch must use file.name.
    const entry = {
      isFile: true,
      isDirectory: false,
      name: 'entry-name',
      file: (resolve: (f: File) => void) => resolve(new File(['x'], 'real.txt')),
    } as unknown as Fake;
    const { files } = await readDroppedEntries([entry]);
    expect(files[0].relativePath).toBe('real.txt');
  });

  it('nests files under their directory path (using entry.name inside dirs)', async () => {
    const tree = [dirEntry('docs', [fileEntry('readme.md'), fileEntry('guide.md')])];
    const { files, directories } = await readDroppedEntries(tree);
    expect(rels(files)).toEqual(['docs/guide.md', 'docs/readme.md']);
    expect(directories).toEqual([]);
  });

  it('records an empty directory as a directory path with no files', async () => {
    const { files, directories } = await readDroppedEntries([dirEntry('empty', [])]);
    expect(files).toEqual([]);
    expect(directories).toEqual(['empty']);
  });

  it('recurses through nested directories, building full relative paths', async () => {
    const tree = [
      dirEntry('a', [
        fileEntry('top.txt'),
        dirEntry('b', [fileEntry('deep.txt'), dirEntry('c', [])]),
      ]),
    ];
    const { files, directories } = await readDroppedEntries(tree);
    expect(rels(files)).toEqual(['a/b/deep.txt', 'a/top.txt']);
    // Only the truly-empty leaf 'a/b/c' is recorded as an empty directory.
    expect(directories).toEqual(['a/b/c']);
  });

  it('handles a mix of top-level files and directories', async () => {
    const tree = [
      fileEntry('root.txt'),
      dirEntry('dir', [fileEntry('inner.txt')]),
      dirEntry('blank', []),
    ];
    const { files, directories } = await readDroppedEntries(tree);
    expect(rels(files)).toEqual(['dir/inner.txt', 'root.txt']);
    expect(directories).toEqual(['blank']);
  });

  it('returns empty results for an empty entry list', async () => {
    const { files, directories } = await readDroppedEntries([]);
    expect(files).toEqual([]);
    expect(directories).toEqual([]);
  });
});

describe('collectDropEntries', () => {
  // Minimal DataTransferItemList fake: indexable + length, items have kind +
  // webkitGetAsEntry().
  const list = (items: Array<{ kind: string; entry: Fake | null }>): DataTransferItemList => {
    const arr = items.map((i) => ({
      kind: i.kind,
      webkitGetAsEntry: () => i.entry,
    }));
    return Object.assign(arr, { length: arr.length }) as unknown as DataTransferItemList;
  };

  it('returns entries for kind "file", skipping other kinds', () => {
    const e1 = fileEntry('a.txt');
    const e2 = dirEntry('d', []);
    const result = collectDropEntries(
      list([
        { kind: 'file', entry: e1 },
        { kind: 'string', entry: fileEntry('ignored') },
        { kind: 'file', entry: e2 },
      ])
    );
    expect(result).toEqual([e1, e2]);
  });

  it('skips items whose webkitGetAsEntry returns null', () => {
    const e1 = fileEntry('a.txt');
    const result = collectDropEntries(
      list([
        { kind: 'file', entry: null },
        { kind: 'file', entry: e1 },
      ])
    );
    expect(result).toEqual([e1]);
  });

  it('returns an empty array for an empty list', () => {
    expect(collectDropEntries(list([]))).toEqual([]);
  });
});

describe('resolveDirectoryCreation', () => {
  it('keeps a single-segment dir under currentPath (root)', () => {
    expect(resolveDirectoryCreation('photos', '/')).toEqual({
      dirName: 'photos',
      parentPath: '/',
    });
  });

  it('keeps a single-segment dir under a nested currentPath', () => {
    expect(resolveDirectoryCreation('photos', '/docs')).toEqual({
      dirName: 'photos',
      parentPath: '/docs',
    });
  });

  it('builds a single-leading-slash parent for nested dirs at root', () => {
    expect(resolveDirectoryCreation('a/b/c', '/')).toEqual({
      dirName: 'c',
      parentPath: '/a/b',
    });
  });

  it('joins nested dirs under a nested currentPath', () => {
    expect(resolveDirectoryCreation('a/b/c', '/docs')).toEqual({
      dirName: 'c',
      parentPath: '/docs/a/b',
    });
  });

  it('handles a two-segment dir at root', () => {
    expect(resolveDirectoryCreation('a/b', '/')).toEqual({ dirName: 'b', parentPath: '/a' });
  });
});
