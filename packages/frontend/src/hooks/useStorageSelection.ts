/**
 * Selection state for the storage file list: checkbox/range selection plus
 * rubber-band (marquee) drag-selection, behind one narrow surface.
 *
 * The caller wires the returned values to the list container and rows; all
 * selection policy (toggle, range, select-all, marquee hit-testing, clearing
 * on navigation) lives here. Geometry math is delegated to the pure
 * {@link ./../utils/marqueeSelection} helpers, so this hook only owns the React
 * state and the DOM measurement needed to feed them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StorageItem } from '../api/storage';
import { pathsInRect, rectFromPoints, type ItemRect, type Rect } from '../utils/marqueeSelection';
import { rangeSelect, removePaths, togglePath } from '../utils/selectionSet';

// Distance (px) the pointer must travel before a press becomes a marquee drag
// rather than a click — avoids hijacking simple clicks on empty space.
const MARQUEE_THRESHOLD = 6;

export interface StorageSelection {
  /** Currently selected item paths. */
  selectedPaths: Set<string>;
  /** Selected items resolved against the current `items` (current view only). */
  selectedItems: StorageItem[];
  /** True when every item in the current view is selected. */
  allSelected: boolean;
  /** True when some — but not all — items are selected (checkbox indeterminate). */
  someSelected: boolean;
  /** The active marquee rectangle in container coordinates, or null when idle. */
  marqueeRect: Rect | null;
  /** Toggle one item; Shift+click range-selects from the last anchor. */
  toggle: (item: StorageItem, e: { shiftKey: boolean }) => void;
  /** Select all when not all selected; otherwise clear. */
  toggleAll: () => void;
  /** Clear the entire selection. */
  clear: () => void;
  /** Remove specific paths from the selection (e.g. after deletion). */
  deselect: (paths: Iterable<string>) => void;
  /** Begin a marquee drag from empty space in the list container. */
  onListMouseDown: (e: React.MouseEvent) => void;
}

/**
 * @param items  Items currently rendered, in display order.
 * @param listContainerRef  The scrollable list container (marquee coordinate origin).
 * @param enabled  Whether marquee listeners should be active (e.g. modal open).
 */
export function useStorageSelection(
  items: StorageItem[],
  listContainerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
): StorageSelection {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);

  // Drag state held in refs so the window listeners stay subscribed once
  // (no per-frame re-subscription) and never close over stale state.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseSelection: Set<string>;
    // Card geometry measured once at mousedown; the list does not reflow
    // during a drag, so pure math can run each frame with no layout reads.
    itemRects: ItemRect[];
    active: boolean;
  } | null>(null);

  const clear = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionAnchor(null);
  }, []);

  const deselect = useCallback((paths: Iterable<string>) => {
    setSelectedPaths((prev) => removePaths(prev, paths));
  }, []);

  const toggle = useCallback(
    (item: StorageItem, e: { shiftKey: boolean }) => {
      setSelectedPaths((prev) =>
        e.shiftKey && selectionAnchor
          ? rangeSelect(
              prev,
              items.map((i) => i.path),
              selectionAnchor,
              item.path
            )
          : togglePath(prev, item.path)
      );
      setSelectionAnchor(item.path);
    },
    [items, selectionAnchor]
  );

  const allSelected = items.length > 0 && selectedPaths.size === items.length;
  const someSelected = selectedPaths.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    if (allSelected) clear();
    else setSelectedPaths(new Set(items.map((i) => i.path)));
  }, [allSelected, clear, items]);

  const selectedItems = useMemo(
    () => items.filter((i) => selectedPaths.has(i.path)),
    [items, selectedPaths]
  );

  // Measure card geometry once into the scroll-content coordinate space.
  const measureItemRects = useCallback((container: HTMLElement): ItemRect[] => {
    const containerBox = container.getBoundingClientRect();
    const cards = container.querySelectorAll<HTMLElement>('[data-storage-path]');
    const rects: ItemRect[] = [];
    cards.forEach((card) => {
      const path = card.getAttribute('data-storage-path');
      if (!path) return;
      const box = card.getBoundingClientRect();
      rects.push({
        path,
        left: box.left - containerBox.left + container.scrollLeft,
        top: box.top - containerBox.top + container.scrollTop,
        width: box.width,
        height: box.height,
      });
    });
    return rects;
  }, []);

  const onListMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only react to primary button on empty area (not a card/control).
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-storage-path], button, input, a')) return;

      const container = listContainerRef.current;
      if (!container) return;

      const containerBox = container.getBoundingClientRect();
      dragRef.current = {
        startX: e.clientX - containerBox.left + container.scrollLeft,
        startY: e.clientY - containerBox.top + container.scrollTop,
        // Additive when a modifier is held; otherwise replaces the selection.
        baseSelection: e.shiftKey || e.metaKey || e.ctrlKey ? new Set(selectedPaths) : new Set(),
        itemRects: measureItemRects(container),
        active: false,
      };
    },
    [listContainerRef, measureItemRects, selectedPaths]
  );

  // Window-level drag listeners: subscribed once while enabled (no churn).
  useEffect(() => {
    if (!enabled) return;

    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      const container = listContainerRef.current;
      if (!drag || !container) return;

      const containerBox = container.getBoundingClientRect();
      const currentX = e.clientX - containerBox.left + container.scrollLeft;
      const currentY = e.clientY - containerBox.top + container.scrollTop;

      // Ignore sub-threshold movement until the drag truly begins.
      if (!drag.active && Math.hypot(currentX - drag.startX, currentY - drag.startY) < MARQUEE_THRESHOLD) {
        return;
      }
      drag.active = true;

      const rect = rectFromPoints(drag.startX, drag.startY, currentX, currentY);
      setMarqueeRect(rect);

      const inRect = pathsInRect(rect, drag.itemRects);
      const next = new Set(drag.baseSelection);
      inRect.forEach((p) => next.add(p));
      setSelectedPaths(next);
    };

    const handleMouseUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setMarqueeRect(null);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, listContainerRef]);

  return {
    selectedPaths,
    selectedItems,
    allSelected,
    someSelected,
    marqueeRect,
    toggle,
    toggleAll,
    clear,
    deselect,
    onListMouseDown,
  };
}
