import { useCallback, useEffect, useMemo } from 'react';
import type { StorageItem } from '../../../api/storage';

export interface PreviewNavigation {
  index: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  prev: () => void;
  next: () => void;
}

/**
 * True when ←/→ belong to the focused element: form fields, media controls,
 * the pane resize handle, or anything inside the viewer body (scrollable
 * code/CSV, the image zoom area) — browsers scroll focused overflow regions
 * with the arrow keys.
 */
function arrowKeysOwnedByTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(target.tagName)) return true;
  if (target.getAttribute('role') === 'separator') return true;
  return target.closest('[data-preview-viewer]') !== null;
}

/**
 * Prev/next over sibling files plus ←/→/Esc shortcuts.
 *
 * Listens on window in the capture phase: the enclosing storage Modal closes on
 * a document-level Escape listener, and capture lets the preview consume Esc
 * first (`onEscape` exits full-screen or closes the preview, never the modal).
 * Pass `enabled: false` while another dialog is stacked on top so it gets Esc.
 */
export function usePreviewNavigation(
  files: StorageItem[],
  current: StorageItem | null,
  onChange: (item: StorageItem) => void,
  { onEscape, enabled = true }: { onEscape: () => void; enabled?: boolean }
): PreviewNavigation {
  const index = useMemo(
    () => (current ? files.findIndex((f) => f.path === current.path) : -1),
    [files, current]
  );
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < files.length - 1;

  const prev = useCallback(() => {
    if (hasPrev) onChange(files[index - 1]);
  }, [files, index, hasPrev, onChange]);
  const next = useCallback(() => {
    if (hasNext) onChange(files[index + 1]);
  }, [files, index, hasNext, onChange]);

  useEffect(() => {
    if (!current || !enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null;
        // Inputs (e.g. the new-folder name field) handle their own Esc.
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (arrowKeysOwnedByTarget(e.target)) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') prev();
      else next();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, enabled, onEscape, prev, next]);

  return { index, total: files.length, hasPrev, hasNext, prev, next };
}
