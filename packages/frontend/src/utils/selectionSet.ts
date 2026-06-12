/**
 * Pure set algebra for list selection. Every function returns a NEW set and
 * never mutates its input, so callers can use the result directly as React
 * state. No React or DOM — the membership rules live here and are unit-tested
 * in isolation; the selection hook only adds state and the anchor.
 */

/** Toggle a single path's membership. */
export function togglePath(selected: Set<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * Add the inclusive range of `order` between `anchor` and `target` to the
 * selection. If `anchor` or `target` is not in `order`, the selection is
 * returned unchanged (as a copy).
 */
export function rangeSelect(
  selected: Set<string>,
  order: string[],
  anchor: string,
  target: string
): Set<string> {
  const next = new Set(selected);
  const start = order.indexOf(anchor);
  const end = order.indexOf(target);
  if (start === -1 || end === -1) return next;
  const [from, to] = start < end ? [start, end] : [end, start];
  for (let i = from; i <= to; i++) next.add(order[i]);
  return next;
}

/** Remove the given paths from the selection. */
export function removePaths(selected: Set<string>, paths: Iterable<string>): Set<string> {
  const remove = new Set(paths);
  const next = new Set<string>();
  selected.forEach((p) => {
    if (!remove.has(p)) next.add(p);
  });
  return next;
}
