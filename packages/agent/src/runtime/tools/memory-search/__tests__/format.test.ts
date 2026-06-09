import { describe, it, expect } from '@jest/globals';
import { formatMemories, formatNoMemories } from '../format.js';

describe('formatNoMemories', () => {
  it('echoes the query in the no-results guidance string', () => {
    expect(formatNoMemories('preferred language')).toBe(
      'No memories found for query: "preferred language". The user may not have relevant past interactions on this topic.'
    );
  });

  it('preserves quotes and special characters in the query verbatim', () => {
    expect(formatNoMemories('a "quoted" topic')).toBe(
      'No memories found for query: "a "quoted" topic". The user may not have relevant past interactions on this topic.'
    );
  });
});

describe('formatMemories', () => {
  it('renders a single memory as a 1-based numbered list under a count header', () => {
    expect(formatMemories('past projects', ['Built a CLI'])).toBe(
      'Found 1 relevant memory record(s) for query "past projects":\n\n1. Built a CLI'
    );
  });

  it('numbers multiple memories sequentially, one per line', () => {
    const result = formatMemories('habits', ['Wakes early', 'Prefers TypeScript', 'Uses Vim']);

    expect(result).toBe(
      'Found 3 relevant memory record(s) for query "habits":\n\n' +
        '1. Wakes early\n2. Prefers TypeScript\n3. Uses Vim'
    );
  });

  it('uses the count of memories, not the topK, in the header', () => {
    // Only the supplied records are counted; the header reflects the array length.
    expect(formatMemories('q', ['only one'])).toContain('Found 1 relevant memory record(s)');
  });
});
