import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileEditorTool } from '../index.js';

/**
 * Behavior tests for the file_editor handler.
 *
 * The handler is exercised through `defineTool`'s `invoke()` seam against a
 * real temporary directory — no fs mocking. `workspaceSync` is absent because
 * no request context is established, so the sync-wait branch is skipped.
 */
describe('fileEditorTool', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-editor-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a new file when oldString is empty and the file is absent', async () => {
    const filePath = join(dir, 'nested', 'new.txt');

    const result = await fileEditorTool.invoke({
      filePath,
      oldString: '',
      newString: 'hello',
    });

    expect(result).toContain('File created successfully');
    expect(result).toContain('Operation: CREATE');
    await expect(readFile(filePath, 'utf8')).resolves.toBe('hello');
  });

  it('refuses to edit a missing file when oldString is provided', async () => {
    const result = await fileEditorTool.invoke({
      filePath: join(dir, 'missing.txt'),
      oldString: 'foo',
      newString: 'bar',
    });

    expect(result).toBe('The file does not exist. Please check again.');
  });

  it('edits an existing file by replacing a unique oldString', async () => {
    const filePath = join(dir, 'edit.txt');
    await writeFile(filePath, 'alpha BETA gamma', 'utf8');

    const result = await fileEditorTool.invoke({
      filePath,
      oldString: 'BETA',
      newString: 'beta',
    });

    expect(result).toContain('File edited successfully');
    expect(result).toContain('Operation: EDIT');
    await expect(readFile(filePath, 'utf8')).resolves.toBe('alpha beta gamma');
  });

  it('rejects editing an existing file when oldString is empty', async () => {
    const filePath = join(dir, 'exists.txt');
    await writeFile(filePath, 'content', 'utf8');

    const result = await fileEditorTool.invoke({
      filePath,
      oldString: '',
      newString: 'whatever',
    });

    expect(result).toBe(
      'The file already exists. Please provide a non-empty oldString to edit it.'
    );
    await expect(readFile(filePath, 'utf8')).resolves.toBe('content');
  });

  it('reports when oldString is not found in the file', async () => {
    const filePath = join(dir, 'edit.txt');
    await writeFile(filePath, 'content', 'utf8');

    const result = await fileEditorTool.invoke({
      filePath,
      oldString: 'absent',
      newString: 'x',
    });

    expect(result).toBe('The file does not contain the oldString. Please check again.');
  });

  it('rejects an oldString that occurs more than once', async () => {
    const filePath = join(dir, 'dup.txt');
    await writeFile(filePath, 'x-x', 'utf8');

    const result = await fileEditorTool.invoke({
      filePath,
      oldString: 'x',
      newString: 'y',
    });

    expect(result).toBe(
      'The file contains multiple occurrences of the oldString. Only one occurrence is allowed.'
    );
    await expect(readFile(filePath, 'utf8')).resolves.toBe('x-x');
  });

  it('surfaces unexpected I/O failures through the shared error formatter', async () => {
    // Point at a path whose parent is a regular file, so readFile/writeFile on a
    // pre-existing entry is fine but creating under it fails with a real errno.
    const fileAsParent = join(dir, 'a-file');
    await writeFile(fileAsParent, 'data', 'utf8');
    const filePath = join(fileAsParent, 'child.txt'); // parent is not a directory

    const result = await fileEditorTool.invoke({
      filePath,
      oldString: '',
      newString: 'x',
    });

    expect(result).toContain('An error occurred while running file_editor:');
  });
});
