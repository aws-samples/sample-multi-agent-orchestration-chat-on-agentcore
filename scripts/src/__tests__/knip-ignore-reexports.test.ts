import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignoreReExports, { reExportRanges } from '../knip-ignore-reexports.js';

const SOURCE = [
  "import { a } from './a';",
  "export { b, type C } from './b';",
  "export type { D } from './d';",
  "export * from './e';",
  'export const local = a;',
  'export { local as alias };',
  '',
].join('\n');

describe('reExportRanges', () => {
  it('covers every `export … from` statement and nothing else', () => {
    const covered = reExportRanges(SOURCE).map(([start, end]) => SOURCE.slice(start, end));
    expect(covered).toEqual([
      "export { b, type C } from './b';",
      "export type { D } from './d';",
      "export * from './e';",
    ]);
  });
});

describe('ignoreReExports', () => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'knip-pre-')), 'index.ts');
  writeFileSync(filePath, SOURCE);
  const issue = (symbol: string) => ({ filePath, pos: SOURCE.indexOf(symbol) });

  it('drops re-export issues, keeps declarations, and lowers the counters to match', () => {
    const options = {
      issues: {
        exports: { 'index.ts': { b: issue('b,'), local: issue('local =') } },
        types: { 'index.ts': { C: issue('C }'), D: issue('D }') } },
        files: { 'unused.ts': { 'unused.ts': { filePath: 'unused.ts' } } },
      },
      counters: { exports: 2, types: 2, files: 1, total: 5 },
    };

    const result = ignoreReExports(options);

    expect(result.issues.exports).toEqual({ 'index.ts': { local: issue('local =') } });
    expect(result.issues.types).toEqual({});
    expect(result.issues.files).toEqual(options.issues.files);
    expect(result.counters).toEqual({ exports: 1, types: 0, files: 1, total: 2 });
  });

  it('keeps an issue on a local `export { x as y }` list', () => {
    const options = {
      issues: { exports: { 'index.ts': { alias: issue('alias }') } }, types: {} },
      counters: { exports: 1, types: 0, total: 1 },
    };
    expect(ignoreReExports(options).counters.exports).toBe(1);
  });
});
