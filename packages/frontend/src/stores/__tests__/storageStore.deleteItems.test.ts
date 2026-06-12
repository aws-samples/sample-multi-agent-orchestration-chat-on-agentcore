/**
 * storageStore — batch delete (deleteItems).
 *
 * deleteItems removes all targeted items optimistically, deletes them in
 * parallel, then restores ONLY the items whose API call failed. A single
 * deleteItem delegates to deleteItems([item]).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStorageStore } from '../storageStore';
import * as storageApi from '../../api/storage';
import type { StorageItem } from '../../api/storage';

vi.mock('../../api/storage');

const fileA: StorageItem = { name: 'a.txt', path: '/a.txt', type: 'file' };
const fileB: StorageItem = { name: 'b.txt', path: '/b.txt', type: 'file' };
const dirC: StorageItem = { name: 'c', path: '/c', type: 'directory' };

describe('storageStore deleteItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStorageStore.setState({
      currentPath: '/',
      items: [dirC, fileA, fileB],
      error: null,
    });
    // Silent sync re-reads the listing; return the current items unchanged.
    vi.mocked(storageApi.listStorageItems).mockResolvedValue({
      items: useStorageStore.getState().items,
      path: '/',
    });
    vi.mocked(storageApi.fetchFolderTree).mockResolvedValue({ tree: [] });
  });

  it('removes all targeted items when every deletion succeeds', async () => {
    vi.mocked(storageApi.deleteFile).mockResolvedValue(undefined);
    vi.mocked(storageApi.deleteDirectory).mockResolvedValue(undefined);
    // listing after deletion reflects only the survivor
    vi.mocked(storageApi.listStorageItems).mockResolvedValue({ items: [fileB], path: '/' });

    await useStorageStore.getState().deleteItems([fileA, dirC]);

    const state = useStorageStore.getState();
    expect(storageApi.deleteFile).toHaveBeenCalledWith('/a.txt');
    expect(storageApi.deleteDirectory).toHaveBeenCalledWith('/c', true);
    expect(state.items.map((i) => i.path)).toEqual(['/b.txt']);
    expect(state.error).toBeNull();
  });

  it('restores only the failed item and surfaces its error', async () => {
    vi.mocked(storageApi.deleteFile).mockImplementation((path: string) =>
      path === '/a.txt' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined)
    );
    // Silent sync should not resurrect deleted items; return what the server "has".
    vi.mocked(storageApi.listStorageItems).mockResolvedValue({
      items: [dirC, fileA],
      path: '/',
    });

    await useStorageStore.getState().deleteItems([fileA, fileB]);

    const state = useStorageStore.getState();
    // fileA failed → restored; fileB succeeded → gone; dirC untouched.
    expect(state.items.map((i) => i.path).sort()).toEqual(['/a.txt', '/c']);
    expect(state.error).toContain('a.txt');
  });

  it('is a no-op for an empty selection', async () => {
    await useStorageStore.getState().deleteItems([]);
    expect(storageApi.deleteFile).not.toHaveBeenCalled();
    expect(storageApi.deleteDirectory).not.toHaveBeenCalled();
  });

  it('deleteItem delegates to the batch path', async () => {
    vi.mocked(storageApi.deleteFile).mockResolvedValue(undefined);
    vi.mocked(storageApi.listStorageItems).mockResolvedValue({
      items: [dirC, fileB],
      path: '/',
    });

    await useStorageStore.getState().deleteItem(fileA);

    expect(storageApi.deleteFile).toHaveBeenCalledWith('/a.txt');
    expect(storageApi.deleteFile).toHaveBeenCalledTimes(1);
  });
});
