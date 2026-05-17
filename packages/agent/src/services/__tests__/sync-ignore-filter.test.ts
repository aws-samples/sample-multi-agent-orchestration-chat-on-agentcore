/**
 * Tests for SyncIgnoreFilter
 * Now imported from @moca/s3-workspace-sync
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SyncIgnoreFilter } from '@moca/s3-workspace-sync';
import type { SyncLogger } from '@moca/s3-workspace-sync';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createSilentLogger(): SyncLogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('SyncIgnoreFilter', () => {
  let tempDir: string;
  let logger: SyncLogger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-ignore-test-'));
    logger = createSilentLogger();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('default patterns', () => {
    it('should ignore system files', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('.DS_Store')).toBe(true);
      expect(filter.isIgnored('Thumbs.db')).toBe(true);
      expect(filter.isIgnored('file.swp')).toBe(true);
      expect(filter.isIgnored('backup~')).toBe(true);
    });

    it('should ignore build artifacts', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('node_modules/package/index.js')).toBe(true);
      expect(filter.isIgnored('__pycache__/module.pyc')).toBe(true);
      expect(filter.isIgnored('test.pyc')).toBe(true);
      expect(filter.isIgnored('build/output.jar')).toBe(true);
      expect(filter.isIgnored('dist/bundle.js')).toBe(true);
      expect(filter.isIgnored('target/classes/Main.class')).toBe(true);
    });

    it('should ignore IDE settings', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('.idea/workspace.xml')).toBe(true);
      expect(filter.isIgnored('.vscode/settings.json')).toBe(true);
      expect(filter.isIgnored('project.iml')).toBe(true);
    });

    it('should ignore log files', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('error.log')).toBe(true);
      expect(filter.isIgnored('logs/app.log')).toBe(true);
    });

    it('should ignore temporary files', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('temp.tmp')).toBe(true);
      expect(filter.isIgnored('file.temp')).toBe(true);
      expect(filter.isIgnored('.cache/data')).toBe(true);
    });

    it('should ignore .syncignore file itself', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('.syncignore')).toBe(true);
    });

    it('should not ignore regular files', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('README.md')).toBe(false);
      expect(filter.isIgnored('src/index.ts')).toBe(false);
      expect(filter.isIgnored('package.json')).toBe(false);
      expect(filter.isIgnored('docs/guide.pdf')).toBe(false);
    });
  });

  describe('custom patterns from .syncignore', () => {
    it('should load custom patterns from .syncignore file', () => {
      const syncignorePath = path.join(tempDir, '.syncignore');
      fs.writeFileSync(
        syncignorePath,
        `# Custom patterns
secrets/
*.key
*.pem
test-data/
`
      );

      const filter = new SyncIgnoreFilter(logger);
      filter.loadFromWorkspace(tempDir);

      expect(filter.isIgnored('secrets/api-key.txt')).toBe(true);
      expect(filter.isIgnored('private.key')).toBe(true);
      expect(filter.isIgnored('cert.pem')).toBe(true);
      expect(filter.isIgnored('test-data/sample.json')).toBe(true);
    });

    it('should handle empty lines and comments', () => {
      const syncignorePath = path.join(tempDir, '.syncignore');
      fs.writeFileSync(
        syncignorePath,
        `# This is a comment

# Another comment
*.secret

# Empty lines should be ignored
`
      );

      const filter = new SyncIgnoreFilter(logger);
      filter.loadFromWorkspace(tempDir);

      expect(filter.isIgnored('password.secret')).toBe(true);
      expect(filter.isIgnored('# This is a comment')).toBe(false);
    });

    it('should work without .syncignore file', () => {
      const filter = new SyncIgnoreFilter(logger);
      filter.loadFromWorkspace(tempDir);

      expect(filter.isIgnored('node_modules/pkg/index.js')).toBe(true);
      expect(filter.isIgnored('README.md')).toBe(false);
    });
  });

  describe('getInfo', () => {
    it('should report default patterns count', () => {
      const filter = new SyncIgnoreFilter(logger);
      const info = filter.getInfo();

      expect(info.defaultPatternsCount).toBeGreaterThan(0);
      expect(info.customPatternsLoaded).toBe(false);
    });

    it('should report custom patterns loaded', () => {
      const syncignorePath = path.join(tempDir, '.syncignore');
      fs.writeFileSync(syncignorePath, '*.custom\n');

      const filter = new SyncIgnoreFilter(logger);
      filter.loadFromWorkspace(tempDir);

      expect(filter.getInfo().customPatternsLoaded).toBe(true);
    });
  });

  describe('filter method', () => {
    it('should filter out ignored paths', () => {
      const filter = new SyncIgnoreFilter(logger);
      const paths = ['src/index.ts', 'node_modules/pkg/index.js', '.DS_Store', 'README.md'];
      const result = filter.filter(paths);

      expect(result).toEqual(['src/index.ts', 'README.md']);
    });
  });

  describe('cross-platform paths', () => {
    it('should handle backslash paths on Windows', () => {
      const filter = new SyncIgnoreFilter(logger);

      expect(filter.isIgnored('node_modules\\pkg\\index.js')).toBe(true);
    });
  });
});
