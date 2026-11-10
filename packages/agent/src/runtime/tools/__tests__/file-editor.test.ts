/**
 * file_editor must write `newString` literally. `String.prototype.replace`
 * with a string replacement expands `$&`, `$$`, `` $` `` and `$'`, which
 * silently corrupts code containing them (shell variables, template text).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: () => undefined,
}));
jest.unstable_mockModule('../../../libs/utils/display-path.js', () => ({
  toDisplayPath: (filePath: string) => filePath,
}));

const { fileEditorTool } = await import('../file-editor.js');

describe('file_editor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-editor-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['$&', 'echo "$&"'],
    ['$$', 'pid=$$'],
    ["$'", "tail=$'"],
    ['$`', 'head=$`'],
  ])('writes a replacement containing %s literally', async (_pattern, newString) => {
    const filePath = join(dir, 'script.sh');
    await writeFile(filePath, 'before\nPLACEHOLDER\nafter\n', 'utf8');

    await fileEditorTool.invoke({ filePath, oldString: 'PLACEHOLDER', newString });

    expect(await readFile(filePath, 'utf8')).toBe(`before\n${newString}\nafter\n`);
  });
});
