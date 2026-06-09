/**
 * Aggregate per-package coverage into a single repo-wide report.
 *
 * Each workspace's `test:coverage` script emits a v8 `coverage-final.json`
 * (Istanbul JSON shape, keyed by absolute file path) under its own
 * `coverage/` directory. Integration suites that need DynamoDB Local emit a
 * second `coverage-integration/coverage-final.json` (see the `*:coverage`
 * integration scripts). This script gathers every such file, merges them
 * with istanbul-lib-coverage — combining per-file hit counts when unit and
 * integration runs both touch a file — and renders lcov, cobertura, and
 * text-summary reports under the repo-root `coverage/`.
 *
 * Both Jest (coverageProvider: 'v8') and Vitest (@vitest/coverage-v8) write
 * the same JSON shape with absolute-path keys, so the maps merge directly
 * without a runner-specific step. We use the istanbul libraries (already
 * transitive deps of both runners) rather than the `nyc` CLI, which breaks
 * on import under Node 24.
 *
 * Usage: tsx scripts/src/merge-coverage.ts
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import libCoverage from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = join(repoRoot, 'packages');
const reportDir = join(repoRoot, 'coverage');

/** Directories never worth walking when hunting for coverage output. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'cdk.out']);

/**
 * Per-package output dirs that may hold a `coverage-final.json`. `coverage/`
 * is the unit-test output; `coverage-integration/` is the DDB-Local
 * integration output (kept separate so the two runs don't clobber each other).
 */
const COVERAGE_DIRS = ['coverage', 'coverage-integration'];

/**
 * Recursively find every `<coverage-dir>/coverage-final.json` under
 * `packages/`. We look for the file by name rather than assuming a fixed
 * depth so that nested workspaces (e.g. packages/libs/*,
 * packages/lambda-tools/*) are all picked up.
 */
function findCoverageFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = join(dir, entry.name);
    for (const covDir of COVERAGE_DIRS) {
      const candidate = join(child, covDir, 'coverage-final.json');
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        found.push(candidate);
      }
    }
    findCoverageFiles(child, found);
  }
  return found;
}

function main(): void {
  const files = findCoverageFiles(packagesDir);

  if (files.length === 0) {
    console.error(
      'No coverage-final.json files found under packages/. ' +
        'Run the per-package coverage first (e.g. `npm run test:coverage`).',
    );
    process.exit(1);
  }

  const map = libCoverage.createCoverageMap({});
  for (const file of files) {
    const pkgPath = relative(packagesDir, dirname(dirname(file)));
    // dirname(file) is `.../coverage` or `.../coverage-integration`.
    const kind = dirname(file).endsWith('coverage-integration') ? 'integration' : 'unit';
    const data = JSON.parse(readFileSync(file, 'utf8'));
    map.merge(data);
    console.log(`  + ${pkgPath} [${kind}] (${Object.keys(data).length} files)`);
  }

  // Reset the report directory so stale reports never linger.
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });

  const context = createContext({ dir: reportDir, coverageMap: map });
  for (const name of ['text-summary', 'lcov', 'cobertura'] as const) {
    reports.create(name).execute(context);
  }

  console.log(`\nReports written to ${relative(repoRoot, reportDir)}/`);
}

main();
