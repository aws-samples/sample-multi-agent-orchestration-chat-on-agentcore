import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'moca.storage.previewPaneRatio';
export const DEFAULT_PANE_RATIO = 0.5;
const MIN_LIST_PX = 280;
const MIN_PANE_PX = 320;
const KEY_STEP_PX = 32;

interface Measure {
  listLeft: number;
  right: number;
  rowWidth: number;
}

function readRatio(): number {
  const v = Number(localStorage.getItem(STORAGE_KEY));
  return v > 0 && v < 1 ? v : DEFAULT_PANE_RATIO;
}

/**
 * Pane width as a ratio of the content row (tree + list + pane), so it scales
 * with the modal. `listRef` is the list column; its parent is the row.
 */
export function useResizablePane(listRef: React.RefObject<HTMLElement | null>) {
  const [ratio, setRatio] = useState(readRatio);
  const [isResizing, setIsResizing] = useState(false);
  const clampRatio = (paneWidth: number, m: Measure) => {
    if (m.rowWidth <= 0) return ratio;
    const max = Math.max(MIN_PANE_PX, m.right - m.listLeft - MIN_LIST_PX);
    return Math.min(max, Math.max(MIN_PANE_PX, paneWidth)) / m.rowWidth;
  };

  const measure = useCallback((): Measure | null => {
    const list = listRef.current?.getBoundingClientRect();
    const row = listRef.current?.parentElement?.getBoundingClientRect();
    if (!list || !row) return null;
    return { listLeft: list.left, right: row.right, rowWidth: row.width };
  }, [listRef]);

  const commit = useCallback((next: number) => {
    setRatio(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!isResizing) return;
    const m = measure();
    if (m) setRatio(clampRatio(m.right - e.clientX, m));
  };
  const onPointerUp = () => {
    if (!isResizing) return;
    setIsResizing(false);
    commit(ratio);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const m = measure();
    if (!m) return;
    // ← moves the divider left, i.e. widens the pane.
    const delta = e.key === 'ArrowLeft' ? KEY_STEP_PX : -KEY_STEP_PX;
    commit(clampRatio(ratio * m.rowWidth + delta, m));
  };

  // Keep text from being selected and show the resize cursor everywhere while dragging.
  useEffect(() => {
    if (!isResizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [isResizing]);

  return {
    // CSS bounds keep the list usable if the modal shrinks after a drag
    // (240px folder tree + MIN_LIST_PX).
    paneStyle: {
      width: `${ratio * 100}%`,
      // min() so the minimum never overrides the maximum (CSS min-width wins)
      // on a narrow modal; the list's reserved width takes priority there.
      minWidth: `min(${MIN_PANE_PX}px, calc(100% - ${240 + MIN_LIST_PX}px))`,
      maxWidth: `calc(100% - ${240 + MIN_LIST_PX}px)`,
    },
    isResizing,
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-valuenow': Math.round(ratio * 100),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: () => commit(DEFAULT_PANE_RATIO),
    },
  };
}
