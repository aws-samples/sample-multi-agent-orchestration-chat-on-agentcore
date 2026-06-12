import { describe, it, expect } from 'vitest';
import { rectFromPoints, pathsInRect, type ItemRect } from '../marqueeSelection';

/**
 * Pure geometry for rubber-band (marquee) selection. No DOM: rectangles are
 * plain numbers in the scroll-content coordinate space, so the math is fully
 * unit-testable and reusable across any list.
 */
describe('rectFromPoints', () => {
  it('builds a normalized rect when dragging down-right', () => {
    expect(rectFromPoints(10, 20, 110, 220)).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 200,
    });
  });

  it('normalizes a rect dragged up-left (anchor below/right of cursor)', () => {
    expect(rectFromPoints(110, 220, 10, 20)).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 200,
    });
  });

  it('produces a zero-size rect when start === current', () => {
    expect(rectFromPoints(50, 50, 50, 50)).toEqual({
      left: 50,
      top: 50,
      width: 0,
      height: 0,
    });
  });
});

describe('pathsInRect', () => {
  // Three stacked 100x60 rows with a 10px gap.
  const items: ItemRect[] = [
    { path: '/a', left: 0, top: 0, width: 100, height: 60 },
    { path: '/b', left: 0, top: 70, width: 100, height: 60 },
    { path: '/c', left: 0, top: 140, width: 100, height: 60 },
  ];

  it('returns paths whose rects intersect the selection rect', () => {
    // Rect covering rows a and b (top 0..100).
    expect(pathsInRect({ left: 0, top: 0, width: 50, height: 100 }, items)).toEqual(['/a', '/b']);
  });

  it('includes a row touched even partially', () => {
    // Rect spanning 125..145: overlaps row b (70..130) by 5px and row c (140..200) by 5px.
    expect(pathsInRect({ left: 0, top: 125, width: 50, height: 20 }, items)).toEqual(['/b', '/c']);
  });

  it('returns empty when the rect lands in a gap', () => {
    // Gap between a (0..60) and b (70..130): 61..69.
    expect(pathsInRect({ left: 0, top: 62, width: 50, height: 5 }, items)).toEqual([]);
  });

  it('excludes rows that only share an edge (no overlap)', () => {
    // Rect bottom exactly at row a's top edge (touching, not overlapping).
    expect(pathsInRect({ left: 0, top: -10, width: 50, height: 10 }, items)).toEqual([]);
  });

  it('returns all rows for a rect that spans the whole list', () => {
    expect(pathsInRect({ left: 0, top: 0, width: 100, height: 200 }, items)).toEqual([
      '/a',
      '/b',
      '/c',
    ]);
  });

  it('preserves item order in the result', () => {
    const reversed = [...items].reverse();
    expect(pathsInRect({ left: 0, top: 0, width: 100, height: 200 }, reversed)).toEqual([
      '/c',
      '/b',
      '/a',
    ]);
  });
});
