import ignore, { Ignore } from 'ignore';
import * as fs from 'fs';
import * as path from 'path';
import type { SyncLogger } from './types.js';

/**
 * Default ignore patterns applied even when no `.syncignore` file exists.
 */
const DEFAULT_PATTERNS = [
  // System files
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*.swo',
  '*~',

  // Build artifacts
  'node_modules/',
  '__pycache__/',
  '*.pyc',
  '.gradle/',
  'build/',
  'dist/',
  'target/',

  // IDE settings
  '.idea/',
  '.vscode/',
  '*.iml',

  // Log files
  '*.log',
  'logs/',

  // Temporary files
  '*.tmp',
  '*.temp',
  '.cache/',

  // Sync configuration itself
  '.syncignore',
];

/**
 * Provides `.gitignore`-style pattern matching for file exclusion during sync.
 *
 * Built-in default patterns cover common system files, build artifacts,
 * IDE settings, and temporary files.  Additional patterns can be loaded
 * from a `.syncignore` file in the workspace root or injected at construction.
 */
export class SyncIgnoreFilter {
  private ig: Ignore;
  private customPatternsLoaded = false;
  private readonly logger: SyncLogger;

  constructor(logger: SyncLogger, additionalPatterns?: string[]) {
    this.logger = logger;
    this.ig = ignore();
    this.ig.add(DEFAULT_PATTERNS);
    this.logger.debug(`Loaded ${DEFAULT_PATTERNS.length} default ignore patterns`);

    if (additionalPatterns && additionalPatterns.length > 0) {
      this.ig.add(additionalPatterns);
      this.logger.debug(`Loaded ${additionalPatterns.length} additional ignore patterns`);
    }
  }

  /**
   * Load custom patterns from a `.syncignore` file in the given workspace directory.
   */
  loadFromWorkspace(workspaceDir: string): void {
    // nosemgrep: path-join-resolve-traversal - workspaceDir is controlled by server configuration, not user input
    const syncignorePath = path.join(workspaceDir, '.syncignore');

    if (!fs.existsSync(syncignorePath)) {
      this.logger.debug('No .syncignore file found, using defaults only');
      return;
    }

    try {
      const content = fs.readFileSync(syncignorePath, 'utf-8');
      const patterns = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      if (patterns.length > 0) {
        this.ig.add(patterns);
        this.customPatternsLoaded = true;
        this.logger.info(`Loaded ${patterns.length} custom patterns from .syncignore`);
      }
    } catch (error) {
      this.logger.warn(`Failed to load .syncignore: ${error}`);
    }
  }

  /**
   * Check if a file should be ignored.
   *
   * @param relativePath - Path relative to the workspace root
   * @returns `true` if the file should be excluded from sync
   */
  isIgnored(relativePath: string): boolean {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    return this.ig.ignores(normalizedPath);
  }

  /**
   * Filter an array of relative paths, removing ignored ones.
   */
  filter(paths: string[]): string[] {
    return paths.filter((p) => !this.isIgnored(p));
  }

  /**
   * Get information about loaded patterns.
   */
  getInfo(): { defaultPatternsCount: number; customPatternsLoaded: boolean } {
    return {
      defaultPatternsCount: DEFAULT_PATTERNS.length,
      customPatternsLoaded: this.customPatternsLoaded,
    };
  }
}
