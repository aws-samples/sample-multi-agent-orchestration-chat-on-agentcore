import { useEffect, useState } from 'react';
import { generateDownloadUrl } from '../../../api/storage';
import { logger } from '../../../utils/logger';

interface FilePreviewUrlState {
  url: string | null;
  error: string | null;
  isLoading: boolean;
}

/**
 * Resolves a presigned GET URL for `path`; pass `null` to skip fetching.
 * `inline` URLs are for native browser viewers (PDF, media).
 */
export function useFilePreviewUrl(path: string | null, inline = false): FilePreviewUrlState {
  const [state, setState] = useState<{
    path: string | null;
    url: string | null;
    error: string | null;
  }>({
    path: null,
    url: null,
    error: null,
  });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    generateDownloadUrl(path, { inline })
      .then((url) => {
        if (!cancelled) setState({ path, url, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logger.error('Failed to generate preview URL:', err);
        setState({ path, url: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, inline]);

  // Derived instead of reset-in-effect so switching files never flashes the
  // previous file's image.
  const isCurrent = state.path === path;
  return {
    url: isCurrent ? state.url : null,
    error: isCurrent ? state.error : null,
    isLoading: !!path && !isCurrent,
  };
}
