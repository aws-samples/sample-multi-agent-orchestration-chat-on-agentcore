/** File name of a storage path (`/a/b.md` → `b.md`). */
export function storageBasename(path: string): string {
  return path.split('/').pop() || path;
}

/** Folder of a storage path without a trailing slash (`/a/b.md` → `/a`, `/b.md` → `/`). */
export function storageDirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '/';
}

/** Absolute user-storage path (not protocol-relative, not the same-origin API). */
export const isStoragePath = (href: string): boolean =>
  href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/');
