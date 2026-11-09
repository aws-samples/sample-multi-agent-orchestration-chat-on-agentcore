/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Read sources from disk: Vitest stubs CSS imports (including `?raw`) to empty strings.
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(SRC_DIR, 'index.css'), 'utf8');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

const findClassUsages = (pattern: RegExp): string[] =>
  sourceFiles(SRC_DIR).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(pattern)].map((m) => `${relative(SRC_DIR, file)}:${i + 1} ${m[0]}`)
      )
  );

const readTokens = (selector: string): Record<string, string> => {
  const start = css.indexOf(selector);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]])
  );
};

const lightTokens = readTokens('@theme static {');
const darkTokens = { ...lightTokens, ...readTokens(":root[data-theme='dark'] {") };

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('Tailwind v4 class hygiene', () => {
  it('does not use *-opacity-* utilities removed in Tailwind v4', () => {
    expect(
      findClassUsages(/\b(?:[\w-]+:)*(?:bg|text|border|divide|ring|placeholder)-opacity-\d+\b/g)
    ).toEqual([]);
  });

  it('does not reference misspelled semantic color tokens', () => {
    expect(
      findClassUsages(
        /\b(?:bg|text|border|ring)-(?:surface-(?:primary|secondary|elevated)|fg-(?:default|secondary|muted|disabled|inverse|link))\d+\b/g
      )
    ).toEqual([]);
  });

  it('does not hard-code light-only colors that break the dark theme', () => {
    expect(
      findClassUsages(
        /\b(?:[\w-]+:)*(?:text-black|text-amber-900|text-green-900|text-indigo-600|bg-blue-100|bg-red-100|bg-gray-900|bg-gray-800|ring-gray-200|ring-blue-100|bg-black\/5|via-white)(?![\w/-])/g
      )
    ).toEqual([]);
  });
});

describe('theme token contrast (WCAG AA)', () => {
  const themes = { light: lightTokens, dark: darkTokens };

  it.each(Object.entries(themes))('%s: button labels meet 4.5:1', (_, t) => {
    expect(contrast(t['action-primary-fg'], t['action-primary'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['action-primary-fg'], t['action-primary-hover'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['action-danger-fg'], t['action-danger'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['action-danger-fg'], t['action-danger-hover'])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.entries(themes))('%s: link text meets 4.5:1 on surfaces', (_, t) => {
    for (const surface of ['surface-primary', 'surface-secondary']) {
      expect(contrast(t['fg-link'], t[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dark: subdued text (fg-disabled) meets 4.5:1 on surfaces', () => {
    for (const surface of ['surface-primary', 'surface-secondary']) {
      expect(contrast(darkTokens['fg-disabled'], darkTokens[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dark: brand-dark headings meet 4.5:1 on surfaces', () => {
    expect(
      contrast(darkTokens['brand-dark'], darkTokens['surface-secondary'])
    ).toBeGreaterThanOrEqual(4.5);
  });
});
