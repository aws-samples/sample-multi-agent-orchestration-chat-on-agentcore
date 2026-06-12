/**
 * Pure geometry for rubber-band (marquee) selection.
 *
 * All coordinates are plain numbers in a single 2-D space (the list's
 * scroll-content space): callers measure DOM once and translate into this
 * space, then this module does the math with no DOM access. That keeps the
 * hit-testing fully unit-testable and independent of how rows are rendered.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A list item's identity plus its rectangle in the shared coordinate space. */
export interface ItemRect extends Rect {
  path: string;
}

/**
 * Build a normalized rectangle from a drag anchor and the current pointer,
 * regardless of drag direction (always non-negative width/height).
 */
export function rectFromPoints(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number
): Rect {
  return {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

/**
 * Return the paths of every item whose rectangle overlaps `rect`, in the order
 * the items were given. Edge-only contact (shared boundary, no area overlap)
 * does not count as a hit.
 */
export function pathsInRect(rect: Rect, items: ItemRect[]): string[] {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;

  return items
    .filter(
      (item) =>
        item.left < right &&
        item.left + item.width > rect.left &&
        item.top < bottom &&
        item.top + item.height > rect.top
    )
    .map((item) => item.path);
}
