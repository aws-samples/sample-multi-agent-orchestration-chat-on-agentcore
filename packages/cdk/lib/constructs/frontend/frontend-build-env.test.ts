/**
 * Vite only exposes VITE_* variables to the bundle, and only the ones the code
 * names. A variable injected here but never read is dead configuration; one the
 * code reads but nobody injects is an empty string in production.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../../..');
const FRONTEND = join(REPO_ROOT, 'packages/frontend');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

const viteVars = (text: string, pattern: RegExp): string[] => [
  ...new Set([...text.matchAll(pattern)].map((m) => m[1])),
];

const frontendCode = [...sourceFiles(join(FRONTEND, 'src')), join(FRONTEND, 'vite.config.ts')]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const read = viteVars(frontendCode, /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g);

const construct = readFileSync(join(__dirname, 'frontend.ts'), 'utf8');
const buildEnvironment = construct.match(/buildEnvironment:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? '';
const injected = viteVars(buildEnvironment, /\b(VITE_[A-Z0-9_]+)\s*:/g);

const setupEnv = readFileSync(join(REPO_ROOT, 'scripts/src/setup-env.ts'), 'utf8');
const writtenLocally = viteVars(setupEnv, /^#?\s*(VITE_[A-Z0-9_]+)=/gm);

// Switches a developer sets by hand in a local .env; production never needs them.
const LOCAL_ONLY = ['VITE_API_DEBUG'];

describe('frontend build environment', () => {
  it('finds variables on every side (sanity check for the scanners)', () => {
    expect(read.length).toBeGreaterThan(5);
    expect(injected.length).toBeGreaterThan(5);
    expect(writtenLocally.length).toBeGreaterThan(3);
  });

  it('injects nothing the frontend does not read', () => {
    expect(injected.filter((name) => !read.includes(name))).toEqual([]);
  });

  it('gives the frontend every variable it reads', () => {
    expect(read.filter((name) => !injected.includes(name) && !LOCAL_ONLY.includes(name))).toEqual(
      []
    );
  });

  it('writes nothing to the local .env that the frontend does not read', () => {
    expect(writtenLocally.filter((name) => !read.includes(name))).toEqual([]);
  });
});
