// Callers must invoke these synchronously inside the click handler:
// downloadWithAsyncUrl opens the tab before awaiting to keep mobile's
// transient activation.

import { generateDownloadUrl } from './storage';
import { downloadWithAsyncUrl } from '../utils/download';
import { getPreviewKind } from '../utils/filePreview';
import { logger } from '../utils/logger';

/**
 * Inline URLs serve anything outside the media allow-list as text/plain, so a
 * new tab only makes sense for types the preview can render (a .zip or .docx
 * would show as garbage). HTML is excluded too: a new tab could only show its
 * source, so links download it and the in-app preview renders it sandboxed.
 */
export function canOpenInNewTab(fileName: string): boolean {
  const kind = getPreviewKind(fileName);
  return kind !== 'unsupported' && kind !== 'html';
}

export async function openFileInNewTab(path: string): Promise<void> {
  await downloadWithAsyncUrl(
    () => generateDownloadUrl(path, { inline: true }),
    (error) => logger.error('Open in new tab error:', error)
  );
}

export async function downloadFile(path: string): Promise<void> {
  await downloadWithAsyncUrl(
    () => generateDownloadUrl(path),
    (error) => logger.error('Download error:', error)
  );
}
