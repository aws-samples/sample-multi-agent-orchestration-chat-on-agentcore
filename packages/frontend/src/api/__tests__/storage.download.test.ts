/**
 * storage download — partial/total failure handling for ZIP downloads.
 *
 * fetchFilesIntoZip (via downloadFolder/downloadItems) must:
 *  - throw when NO file could be fetched (never present an empty ZIP as success)
 *  - report accurate succeeded/failed counts when some files fail
 *  - only count successfully-fetched files as `succeeded`
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as storageApi from '../storage';
import type { DownloadFileInfo } from '../storage';
import { backendClient } from '../client/backend-client';

// Mock the backend metadata calls; the file fetches go through global fetch.
// downloadFolder -> getFolderDownloadInfo -> backendClient.get('/storage/download-folder')
vi.mock('../client/backend-client', () => ({
  backendClient: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

const file = (relativePath: string): DownloadFileInfo => ({
  relativePath,
  downloadUrl: `https://s3.example/${relativePath}`,
  size: 10,
});

const mockFolderInfo = (files: DownloadFileInfo[]) => {
  vi.mocked(backendClient.get).mockResolvedValue({
    files,
    totalSize: files.reduce((s, f) => s + f.size, 0),
    fileCount: files.length,
  });
};

const okResponse = () =>
  ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as Response;
const notOkResponse = () => ({ ok: false, statusText: 'Forbidden' }) as unknown as Response;

describe('downloadFolder partial/total failure', () => {
  beforeEach(() => {
    // jsdom is not the env (node), so stub the DOM bits fetchFilesIntoZip touches
    // on success. URL + anchor are only reached when at least one file succeeds.
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('Blob', class {});
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws when every file fails (no empty ZIP presented as success)', async () => {
    mockFolderInfo([file('a.txt'), file('b.txt')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => notOkResponse())
    );

    await expect(storageApi.downloadFolder('/dir', 'dir')).rejects.toThrow(
      'Failed to download any files'
    );
  });

  it('reports accurate failed count on partial success', async () => {
    mockFolderInfo([file('ok.txt'), file('bad.txt'), file('boom.txt')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('ok.txt')) return okResponse();
        if (url.endsWith('bad.txt')) return notOkResponse();
        throw new Error('network down'); // boom.txt
      })
    );

    const result = await storageApi.downloadFolder('/dir', 'dir');
    expect(result).toEqual({ total: 3, succeeded: 1, failed: 2 });
  });

  it('reports zero failures when all succeed', async () => {
    mockFolderInfo([file('a.txt'), file('b.txt')]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse())
    );

    const result = await storageApi.downloadFolder('/dir', 'dir');
    expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
  });
});
