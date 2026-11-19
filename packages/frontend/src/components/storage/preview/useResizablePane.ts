import { useCallback, useEffect, useState } from 'react';

export const DEFAULT_PANE_RATIO = 0.5;
const KEY_STEP_PX = 32;

export interface ResizablePaneOptions {
  /** localStorage key the ratio is persisted under. */
  storageKey?: string;
  defaultRatio?: number;
  /** Minimum width kept for the column left of the pane. */
  minListPx?: number;
  minPanePx?: number;
  /**
   * Width reserved in CSS for everything left of the pane in the row, so the
   * list stays usable if the row shrinks after a drag.
   */
  reservedPx?: number;
}

// Storage modal: 240px folder tree + 280px list.
const STORAGE_MODAL_DEFAULTS: Required<ResizablePaneOptions> = {
  storageKey: 'moca.storage.previewPaneRatio',
  defaultRatio: DEFAULT_PANE_RATIO,
  minListPx: 280,
  minPanePx: 320,
  reservedPx: 240 + 280,
};

interface Measure {
  listLeft: number;
  right: number;
  rowWidth: number;
}

function readRatio(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return v > 0 && v < 1 ? v : fallback;
}

/**
 * Pane width as a ratio of the content row (e.g. tree + list + pane), so it
 * scales with the container. `listRef` is the column left of the pane; its
 * parent is the row.
 */
export function useResizablePane(
  listRef: React.RefObject<HTMLElement | null>,
  options: ResizablePaneOptions = {}
) {
  const { storageKey, defaultRatio, minListPx, minPanePx, reservedPx } = {
    ...STORAGE_MODAL_DEFAULTS,
    ...options,
  };
  const [ratio, setRatio] = useState(() => readRatio(storageKey, defaultRatio));
  const [isResizing, setIsResizing] = useState(false);
  const clampRatio = (paneWidth: number, m: Measure) => {
    if (m.rowWidth <= 0) return ratio;
    const max = Math.max(minPanePx, m.right - m.listLeft - minListPx);
    return Math.min(max, Math.max(minPanePx, paneWidth)) / m.rowWidth;
  };

  const measure = useCallback((): Measure | null => {
    const list = listRef.current?.getBoundingClientRect();
    const row = listRef.current?.parentElement?.getBoundingClientRect();
    if (!list || !row) return null;
    return { listLeft: list.left, right: row.right, rowWidth: row.width };
  }, [listRef]);

  const commit = useCallback(
    (next: number) => {
      setRatio(next);
      localStorage.setItem(storageKey, String(next));
    },
    [storageKey]
  );

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
    // CSS bounds keep the list usable if the row shrinks after a drag.
    paneStyle: {
      width: `${ratio * 100}%`,
      // min() so the minimum never overrides the maximum (CSS min-width wins)
      // on a narrow row; the list's reserved width takes priority there.
      minWidth: `min(${minPanePx}px, calc(100% - ${reservedPx}px))`,
      maxWidth: `calc(100% - ${reservedPx}px)`,
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
      onDoubleClick: () => commit(defaultRatio),
    },
  };
}
