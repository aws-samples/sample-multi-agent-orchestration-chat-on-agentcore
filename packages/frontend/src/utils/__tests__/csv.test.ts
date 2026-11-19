import { describe, expect, it } from 'vitest';
import { parseDelimited } from '../csv';

describe('parseDelimited', () => {
  it('parses quoted fields, escaped quotes and embedded newlines', () => {
    const csv = 'name,note\r\n"Doe, J","said ""hi""\nthere"\nplain,x\n';
    expect(parseDelimited(csv, ',', 100)).toEqual({
      rows: [
        ['name', 'note'],
        ['Doe, J', 'said "hi"\nthere'],
        ['plain', 'x'],
      ],
      hasMore: false,
    });
  });

  it('handles TSV and a missing trailing newline', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t', 100).rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty trailing fields', () => {
    expect(parseDelimited('a,,\n', ',', 100).rows).toEqual([['a', '', '']]);
  });

  it('stops at maxRows and reports more', () => {
    expect(parseDelimited('1\n2\n3\n', ',', 2)).toEqual({ rows: [['1'], ['2']], hasMore: true });
  });
});
