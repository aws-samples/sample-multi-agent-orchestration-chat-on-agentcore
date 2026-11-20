import { describe, it, expect } from 'vitest';
import { hasInAppFileLink } from '../fileLinks';

describe('hasInAppFileLink', () => {
  it.each([
    ['[report](/docs/report.md)', true],
    ['[spaced](</docs/my report.md>)', true],
    ['[q](/docs/report.md?x=1)', true],
    ['[web](https://example.com/a.md)', false],
    ['[proto](//cdn.example.com/a.md)', false],
    ['[api](/api/sessions)', false],
    ['[video](/clips/demo.MP4)', false],
    ['plain /docs/report.md mention', false],
  ])('%s → %s', (markdown, expected) => {
    expect(hasInAppFileLink(markdown)).toBe(expected);
  });
});
