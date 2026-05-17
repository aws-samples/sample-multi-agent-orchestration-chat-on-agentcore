import { describe, it, expect } from 'vitest';
import { validateStoragePath } from '../src/utils/path-validator.js';
import { PathValidationError } from '../src/errors.js';

describe('validateStoragePath', () => {
  describe('valid paths', () => {
    it.each([
      'workspace',
      'my-workspace',
      'user/workspace',
      'dev01/deck',
      'a/b/c/d',
      'file.txt',
      'path/to/file.txt',
      '',
      '/',
      // Non-ASCII / locale-specific paths must be accepted (issue #363).
      // S3 object keys legitimately allow Unicode and spaces.
      'パス',
      '橋本さんのレス',
      'プロジェクト/資料 2026',
      'path with spaces',
      'mixed/日本語/folder name',
      '全角スペース　あり',
      // ASCII punctuation that is valid in S3 keys.
      'path@special',
      'path#hash',
      'path$dollar',
      'path!bang',
      'path(paren)',
      'path+plus',
      "path'quote",
    ])('accepts "%s"', (path) => {
      expect(() => validateStoragePath(path)).not.toThrow();
    });
  });

  describe('path traversal', () => {
    it('rejects ".." sequences', () => {
      expect(() => validateStoragePath('../etc/passwd')).toThrow(PathValidationError);
      expect(() => validateStoragePath('foo/../../bar')).toThrow(PathValidationError);
      expect(() => validateStoragePath('..')).toThrow(PathValidationError);
    });
  });

  describe('control characters', () => {
    it('rejects null bytes', () => {
      expect(() => validateStoragePath('foo\0bar')).toThrow(PathValidationError);
    });

    it('rejects other ASCII control characters', () => {
      expect(() => validateStoragePath('foo\x01bar')).toThrow(PathValidationError);
      expect(() => validateStoragePath('foo\nbar')).toThrow(PathValidationError);
      expect(() => validateStoragePath('foo\rbar')).toThrow(PathValidationError);
      expect(() => validateStoragePath('foo\tbar')).toThrow(PathValidationError);
      expect(() => validateStoragePath('foo\x7Fbar')).toThrow(PathValidationError);
    });
  });

  describe('backslashes', () => {
    it('rejects backslashes (Windows-style paths)', () => {
      expect(() => validateStoragePath('foo\\bar')).toThrow(PathValidationError);
      expect(() => validateStoragePath('C:\\Users\\foo')).toThrow(PathValidationError);
    });
  });

  describe('protocol-relative paths', () => {
    it('rejects "//" prefix', () => {
      expect(() => validateStoragePath('//evil.com/path')).toThrow(PathValidationError);
    });
  });

  describe('excessive depth', () => {
    it('rejects paths deeper than 50 levels', () => {
      const deepPath = Array(51).fill('a').join('/');
      expect(() => validateStoragePath(deepPath)).toThrow(PathValidationError);
    });

    it('accepts paths at exactly 50 levels', () => {
      const deepPath = Array(50).fill('a').join('/');
      expect(() => validateStoragePath(deepPath)).not.toThrow();
    });
  });

  // Defensive type checking: callers receive `storagePath` from JSON bodies,
  // so a malformed payload could deliver a non-string. Without this guard,
  // `storagePath.includes(...)` raises a raw TypeError that bubbles up to
  // the error-handler middleware as HTTP 500 — the same failure surface
  // as issue #363.
  describe('non-string inputs', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['boolean', true],
      ['object', { foo: 'bar' }],
      ['array', ['a', 'b']],
    ])('rejects %s with PathValidationError', (_label, value) => {
      expect(() => validateStoragePath(value as unknown as string)).toThrow(PathValidationError);
    });
  });

  // Aligns with S3 object key size limit (1024 UTF-8 bytes). Reject
  // oversize paths up-front rather than letting them reach the SDK or
  // consume CPU/memory in `split('/')`.
  describe('maximum length', () => {
    it('accepts an ASCII path of exactly 1024 bytes', () => {
      const path = 'a'.repeat(1024);
      expect(() => validateStoragePath(path)).not.toThrow();
    });

    it('rejects an ASCII path of 1025 bytes', () => {
      const path = 'a'.repeat(1025);
      expect(() => validateStoragePath(path)).toThrow(PathValidationError);
    });

    it('measures length in UTF-8 bytes, not code units (multibyte)', () => {
      // Each Japanese character is 3 bytes in UTF-8.
      // 341 * 3 = 1023 bytes -> accepted.
      const okPath = 'あ'.repeat(341);
      expect(() => validateStoragePath(okPath)).not.toThrow();

      // 342 * 3 = 1026 bytes -> rejected.
      const tooLongPath = 'あ'.repeat(342);
      expect(() => validateStoragePath(tooLongPath)).toThrow(PathValidationError);
    });
  });
});
