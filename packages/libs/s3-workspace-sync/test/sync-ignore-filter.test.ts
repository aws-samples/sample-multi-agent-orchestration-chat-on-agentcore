import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncIgnoreFilter } from '../src/sync-ignore-filter.js';
import type { SyncLogger } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createSilentLogger(): SyncLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('SyncIgnoreFilter', () => {
  let logger: SyncLogger;

  beforeEach(() => {
    logger = createSilentLogger();
  });

  describe('default patterns', () => {
    it('ignores .DS_Store', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('.DS_Store')).toBe(true);
    });

    it('ignores node_modules', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('node_modules/package/index.js')).toBe(true);
    });

    it('ignores build artifacts', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('dist/index.js')).toBe(true);
      expect(filter.isIgnored('build/output.js')).toBe(true);
      expect(filter.isIgnored('__pycache__/module.pyc')).toBe(true);
    });

    it('ignores IDE settings', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('.idea/workspace.xml')).toBe(true);
      expect(filter.isIgnored('.vscode/settings.json')).toBe(true);
    });

    it('ignores log files', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('app.log')).toBe(true);
      expect(filter.isIgnored('logs/error.log')).toBe(true);
    });

    it('ignores temp files', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('file.tmp')).toBe(true);
      expect(filter.isIgnored('file.temp')).toBe(true);
      expect(filter.isIgnored('.cache/data')).toBe(true);
    });

    it('ignores .syncignore itself', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('.syncignore')).toBe(true);
    });

    it('does not ignore regular source files', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('src/index.ts')).toBe(false);
      expect(filter.isIgnored('README.md')).toBe(false);
      expect(filter.isIgnored('data/report.csv')).toBe(false);
    });
  });

  describe('additional patterns', () => {
    it('applies patterns passed to constructor', () => {
      const filter = new SyncIgnoreFilter(logger, ['*.secret', 'private/']);
      expect(filter.isIgnored('api.secret')).toBe(true);
      expect(filter.isIgnored('private/keys.pem')).toBe(true);
      expect(filter.isIgnored('public/index.html')).toBe(false);
    });
  });

  describe('loadFromWorkspace', () => {
    it('loads patterns from .syncignore file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncignore-test-'));

      try {
        fs.writeFileSync(
          path.join(tmpDir, '.syncignore'),
          '# Custom patterns\n*.custom\nsecrets/\n'
        );

        const filter = new SyncIgnoreFilter(logger);
        filter.loadFromWorkspace(tmpDir);

        expect(filter.isIgnored('file.custom')).toBe(true);
        expect(filter.isIgnored('secrets/api-key')).toBe(true);
        expect(filter.isIgnored('src/app.ts')).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles missing .syncignore gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncignore-test-'));

      try {
        const filter = new SyncIgnoreFilter(logger);
        filter.loadFromWorkspace(tmpDir);
        // Should not throw
        expect(filter.isIgnored('src/app.ts')).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('filter', () => {
    it('filters an array of paths', () => {
      const filter = new SyncIgnoreFilter(logger);
      const paths = [
        'src/index.ts',
        'node_modules/pkg/index.js',
        '.DS_Store',
        'README.md',
        'dist/bundle.js',
      ];
      const filtered = filter.filter(paths);
      expect(filtered).toEqual(['src/index.ts', 'README.md']);
    });
  });

  describe('getInfo', () => {
    it('reports correct info before loading custom patterns', () => {
      const filter = new SyncIgnoreFilter(logger);
      const info = filter.getInfo();
      expect(info.defaultPatternsCount).toBeGreaterThan(0);
      expect(info.customPatternsLoaded).toBe(false);
    });

    it('reports custom patterns loaded after loadFromWorkspace', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncignore-test-'));

      try {
        fs.writeFileSync(path.join(tmpDir, '.syncignore'), '*.custom\n');
        const filter = new SyncIgnoreFilter(logger);
        filter.loadFromWorkspace(tmpDir);
        expect(filter.getInfo().customPatternsLoaded).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('cross-platform path normalization', () => {
    it('normalizes backslashes to forward slashes', () => {
      const filter = new SyncIgnoreFilter(logger);
      expect(filter.isIgnored('node_modules\\pkg\\index.js')).toBe(true);
    });
  });
});
