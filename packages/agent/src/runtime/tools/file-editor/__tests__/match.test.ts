import { describe, it, expect } from '@jest/globals';
import { isSingleOccurrence } from '../match.js';

describe('isSingleOccurrence', () => {
  it('returns undefined when the substring is absent', () => {
    expect(isSingleOccurrence('hello world', 'xyz')).toBeUndefined();
  });

  it('returns true for exactly one occurrence', () => {
    expect(isSingleOccurrence('hello world', 'world')).toBe(true);
  });

  it('returns false for multiple occurrences', () => {
    expect(isSingleOccurrence('a-a-a', 'a')).toBe(false);
  });

  it('treats whitespace and indentation literally', () => {
    expect(isSingleOccurrence('  indented\nplain', '  indented')).toBe(true);
    expect(isSingleOccurrence('x\nx', 'x')).toBe(false);
  });
});
