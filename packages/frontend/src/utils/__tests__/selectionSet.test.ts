import { describe, it, expect } from 'vitest';
import { togglePath, rangeSelect, removePaths } from '../selectionSet';

/**
 * Pure set algebra for list selection — no React, no DOM. The hook layers
 * state/anchors on top; this module owns the membership rules.
 */
describe('togglePath', () => {
  it('adds a path that is not selected', () => {
    expect([...togglePath(new Set(['/a']), '/b')]).toEqual(['/a', '/b']);
  });

  it('removes a path that is selected', () => {
    expect([...togglePath(new Set(['/a', '/b']), '/a')]).toEqual(['/b']);
  });

  it('does not mutate the input set', () => {
    const input = new Set(['/a']);
    togglePath(input, '/b');
    expect([...input]).toEqual(['/a']);
  });
});

describe('rangeSelect', () => {
  const order = ['/a', '/b', '/c', '/d', '/e'];

  it('adds the inclusive range from anchor to target (forward)', () => {
    expect([...rangeSelect(new Set(), order, '/b', '/d')]).toEqual(['/b', '/c', '/d']);
  });

  it('adds the inclusive range when target is before anchor (backward)', () => {
    expect([...rangeSelect(new Set(), order, '/d', '/b')]).toEqual(['/b', '/c', '/d']);
  });

  it('merges the range into an existing selection', () => {
    expect([...rangeSelect(new Set(['/e']), order, '/a', '/b')].sort()).toEqual([
      '/a',
      '/b',
      '/e',
    ]);
  });

  it('returns the existing selection unchanged when anchor is not found', () => {
    expect([...rangeSelect(new Set(['/a']), order, '/missing', '/c')]).toEqual(['/a']);
  });

  it('selects a single item when anchor === target', () => {
    expect([...rangeSelect(new Set(), order, '/c', '/c')]).toEqual(['/c']);
  });
});

describe('removePaths', () => {
  it('removes the given paths', () => {
    expect([...removePaths(new Set(['/a', '/b', '/c']), ['/b'])].sort()).toEqual(['/a', '/c']);
  });

  it('ignores paths that are not present', () => {
    expect([...removePaths(new Set(['/a']), ['/x'])]).toEqual(['/a']);
  });

  it('does not mutate the input set', () => {
    const input = new Set(['/a', '/b']);
    removePaths(input, ['/a']);
    expect([...input]).toEqual(['/a', '/b']);
  });
});
