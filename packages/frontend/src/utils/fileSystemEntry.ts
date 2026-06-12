/**
 * Drag-and-drop file/folder ingestion for the storage modal.
 *
 * A drop's `DataTransferItemList` must be read synchronously (it is cleared
 * after the event tick), so the work is split into three pieces the caller
 * sequences:
 *   1. {@link collectDropEntries} — SYNCHRONOUS; pull the top-level
 *      `FileSystemEntry[]` out of the list before any `await`.
 *   2. {@link readDroppedEntries} — async walk into uploadable files +
 *      recursively-empty directory paths.
 *   3. {@link resolveDirectoryCreation} — pure path math for where each empty
 *      directory is created.
 *
 * Everything here is framework-agnostic and unit-tested; the modal keeps the
 * store calls (createDirectory / uploadFiles) and the drag-over UI state.
 */

/** A file paired with its path relative to the drop root (e.g. "dir/sub/a.txt"). */
export interface DroppedEntry {
  file: File;
  relativePath: string;
}

export interface CollectedEntries {
  files: DroppedEntry[];
  /** Relative paths of directories that contain no files (recursively empty). */
  directories: string[];
}

const readFile = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

const readChildren = (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => entry.createReader().readEntries(resolve, reject));

/**
 * Synchronously collect the top-level entries from a drop's item list.
 *
 * MUST be called before any `await` in the drop handler: `DataTransferItemList`
 * is invalidated once the handler yields. Skips non-file items (e.g. dragged
 * text) and items whose `webkitGetAsEntry()` returns null.
 */
export function collectDropEntries(items: DataTransferItemList): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/**
 * Recursively read a directory entry. Note: `readEntries` is called once (not
 * drained in a loop); Chromium caps each call at ~100 entries, so directories
 * with more children are under-read. This matches long-standing behavior and is
 * intentionally preserved here — do not "fix" without measuring upload impact.
 */
async function readDirectoryEntry(
  directoryEntry: FileSystemDirectoryEntry,
  path: string
): Promise<CollectedEntries> {
  const files: DroppedEntry[] = [];
  const directories: string[] = [];
  const children = await readChildren(directoryEntry);

  // No children → an empty directory that must be created explicitly.
  if (children.length === 0) {
    directories.push(path);
    return { files, directories };
  }

  for (const child of children) {
    const childPath = path ? `${path}/${child.name}` : child.name;
    if (child.isFile) {
      files.push({ file: await readFile(child as FileSystemFileEntry), relativePath: childPath });
    } else if (child.isDirectory) {
      const nested = await readDirectoryEntry(child as FileSystemDirectoryEntry, childPath);
      files.push(...nested.files);
      directories.push(...nested.directories);
    }
  }

  return { files, directories };
}

/**
 * Walk already-collected top-level entries into a flat file list plus the paths
 * of recursively-empty directories.
 *
 * Top-level files use their resolved `File.name` as the relative path; files
 * found inside directories use `entry.name` joined under the directory path.
 * This asymmetry matches the original handler and is deliberate.
 */
export async function readDroppedEntries(entries: FileSystemEntry[]): Promise<CollectedEntries> {
  const files: DroppedEntry[] = [];
  const directories: string[] = [];

  for (const entry of entries) {
    if (entry.isFile) {
      const file = await readFile(entry as FileSystemFileEntry);
      files.push({ file, relativePath: file.name });
    } else if (entry.isDirectory) {
      const nested = await readDirectoryEntry(entry as FileSystemDirectoryEntry, entry.name);
      files.push(...nested.files);
      directories.push(...nested.directories);
    }
  }

  return { files, directories };
}

/**
 * Resolve where an empty directory (given by its drop-relative path) should be
 * created: its leaf name and the parent path under `currentPath`. Avoids double
 * slashes when `currentPath` is the root.
 */
export function resolveDirectoryCreation(
  dirPath: string,
  currentPath: string
): { dirName: string; parentPath: string } {
  const pathParts = dirPath.split('/');
  const dirName = pathParts[pathParts.length - 1];
  const parentPath =
    pathParts.length > 1
      ? currentPath === '/'
        ? `/${pathParts.slice(0, -1).join('/')}`
        : `${currentPath}/${pathParts.slice(0, -1).join('/')}`
      : currentPath;
  return { dirName, parentPath };
}
