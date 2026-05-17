/**
 * Storage Directory Route - Path Traversal Validation Tests
 *
 * Tests the directoryName validation logic added to POST /storage/directory.
 * The regex and null-byte check are extracted and tested directly,
 * following the same unit-test pattern as the rest of this package.
 */

import { describe, it, expect } from '@jest/globals';

// ---------------------------------------------------------------------------
// Extraction of the validation logic from src/routes/storage.ts
// Keep this in sync with the route implementation.
// ---------------------------------------------------------------------------
function isInvalidDirectoryName(directoryName: string): boolean {
  return (
    /(\.\.[/\\])|(^\.\.$)|(^\.\.\/)|([/\\]\.\.$)/.test(directoryName) ||
    directoryName.includes('\0')
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('directoryName path traversal validation', () => {
  // ── should be rejected (400) ──────────────────────────────────────────────
  it('rejects "../" prefix', () => {
    expect(isInvalidDirectoryName('../foo')).toBe(true);
  });

  it('rejects "../../etc/passwd" style traversal', () => {
    expect(isInvalidDirectoryName('../../etc/passwd')).toBe(true);
  });

  it('rejects ".." alone', () => {
    expect(isInvalidDirectoryName('..')).toBe(true);
  });

  it('rejects embedded "/../" traversal', () => {
    expect(isInvalidDirectoryName('foo/../bar')).toBe(true);
  });

  it('rejects trailing "/.."', () => {
    expect(isInvalidDirectoryName('foo/..')).toBe(true);
  });

  it('rejects Windows-style "..\\foo" traversal', () => {
    expect(isInvalidDirectoryName('..\\foo')).toBe(true);
  });

  it('rejects Windows-style embedded "foo\\..\\bar"', () => {
    expect(isInvalidDirectoryName('foo\\..\\bar')).toBe(true);
  });

  it('rejects null byte injection', () => {
    expect(isInvalidDirectoryName('foo\0bar')).toBe(true);
  });

  it('rejects leading null byte', () => {
    expect(isInvalidDirectoryName('\0secret')).toBe(true);
  });

  // ── should be accepted (passes validation) ────────────────────────────────
  it('accepts a simple directory name', () => {
    expect(isInvalidDirectoryName('my-folder')).toBe(false);
  });

  it('accepts a name with a leading dot (hidden folder)', () => {
    expect(isInvalidDirectoryName('.hidden')).toBe(false);
  });

  it('accepts nested path without traversal', () => {
    expect(isInvalidDirectoryName('projects/2024/reports')).toBe(false);
  });

  it('accepts a name containing "dots.in.name"', () => {
    expect(isInvalidDirectoryName('dots.in.name')).toBe(false);
  });

  it('accepts a name that starts with ".." as part of a longer word', () => {
    // "..foo" – starts with ".." but no separator immediately after → valid
    expect(isInvalidDirectoryName('..foo')).toBe(false);
  });
});
