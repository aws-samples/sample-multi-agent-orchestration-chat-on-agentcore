/**
 * Unit tests for workspace-sync-helper utilities
 */

import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
  WORKSPACE_DIRECTORY: '/tmp/ws',
  SKILLS_DIR_NAME: '.skills',
}));

const { validateStoragePath } = await import('../workspace-sync-helper.js');

describe('validateStoragePath', () => {
  describe('valid paths', () => {
    it('should accept simple path', () => {
      expect(() => validateStoragePath('documents')).not.toThrow();
    });

    it('should accept path with forward slashes', () => {
      expect(() => validateStoragePath('documents/project/src')).not.toThrow();
    });

    it('should accept path with leading slash', () => {
      expect(() => validateStoragePath('/documents')).not.toThrow();
    });

    it('should accept path with trailing slash', () => {
      expect(() => validateStoragePath('documents/')).not.toThrow();
    });

    it('should accept path with hyphens and underscores', () => {
      expect(() => validateStoragePath('my-project/sub_folder')).not.toThrow();
    });

    it('should accept path with numbers', () => {
      expect(() => validateStoragePath('project123/v2')).not.toThrow();
    });

    it('should accept path with dots (file extensions)', () => {
      expect(() => validateStoragePath('documents/file.txt')).not.toThrow();
    });

    it('should accept empty path', () => {
      expect(() => validateStoragePath('')).not.toThrow();
    });

    it('should accept root path', () => {
      expect(() => validateStoragePath('/')).not.toThrow();
    });

    // Issue #363: Unicode and spaces are valid in S3 object keys.
    it('should accept path with Japanese characters', () => {
      expect(() => validateStoragePath('documents/\u4E2D\u6587')).not.toThrow();
      expect(() => validateStoragePath('\u6A4B\u672C\u3055\u3093\u306E\u30EC\u30B9')).not.toThrow();
    });

    it('should accept path with half-width spaces', () => {
      expect(() => validateStoragePath('my documents')).not.toThrow();
    });

    it('should accept path with mixed unicode and spaces', () => {
      expect(() =>
        validateStoragePath('\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8/folder name')
      ).not.toThrow();
    });

    it('should accept ASCII punctuation valid in S3 keys', () => {
      expect(() => validateStoragePath('documents@home')).not.toThrow();
      expect(() => validateStoragePath('documents/*')).not.toThrow();
      expect(() => validateStoragePath('documents?query')).not.toThrow();
      expect(() => validateStoragePath('C:/documents')).not.toThrow();
    });
  });

  describe('path traversal prevention', () => {
    it('should reject path with double dots', () => {
      expect(() => validateStoragePath('../')).toThrow(
        "path traversal sequences ('..') are not allowed"
      );
    });

    it('should reject path with double dots in middle', () => {
      expect(() => validateStoragePath('documents/../secrets')).toThrow(
        "path traversal sequences ('..') are not allowed"
      );
    });

    it('should reject path with multiple traversal sequences', () => {
      expect(() => validateStoragePath('a/../../b')).toThrow(
        "path traversal sequences ('..') are not allowed"
      );
    });

    it('should reject path attempting to escape user directory', () => {
      expect(() => validateStoragePath('../../../other-user/data')).toThrow(
        "path traversal sequences ('..') are not allowed"
      );
    });
  });

  describe('control character prevention', () => {
    it('should reject path with null byte', () => {
      expect(() => validateStoragePath('documents\0/secret')).toThrow(
        'control characters (including null bytes) are not allowed'
      );
    });

    it('should reject path with other ASCII control characters', () => {
      expect(() => validateStoragePath('foo\x01bar')).toThrow(
        'control characters (including null bytes) are not allowed'
      );
      expect(() => validateStoragePath('foo\nbar')).toThrow(
        'control characters (including null bytes) are not allowed'
      );
      expect(() => validateStoragePath('foo\rbar')).toThrow(
        'control characters (including null bytes) are not allowed'
      );
      expect(() => validateStoragePath('foo\tbar')).toThrow(
        'control characters (including null bytes) are not allowed'
      );
      expect(() => validateStoragePath('foo\x7Fbar')).toThrow(
        'control characters (including null bytes) are not allowed'
      );
    });
  });

  describe('backslash prevention', () => {
    it('should reject path with backslashes', () => {
      expect(() => validateStoragePath('documents\\subfolder')).toThrow(
        'backslashes are not allowed'
      );
    });
  });

  describe('protocol-relative path prevention', () => {
    it('should reject protocol-relative paths', () => {
      expect(() => validateStoragePath('//evil.com/path')).toThrow(
        'protocol-relative paths are not allowed'
      );
    });
  });

  describe('path depth limit', () => {
    it('should accept path with reasonable depth', () => {
      const path = Array(10).fill('dir').join('/');
      expect(() => validateStoragePath(path)).not.toThrow();
    });

    it('should accept path at maximum depth (50)', () => {
      const path = Array(50).fill('d').join('/');
      expect(() => validateStoragePath(path)).not.toThrow();
    });

    it('should reject path exceeding maximum depth', () => {
      const path = Array(51).fill('d').join('/');
      expect(() => validateStoragePath(path)).toThrow('path depth exceeds maximum allowed (50)');
    });
  });

  // Defends against malformed JSON payloads that could deliver
  // non-string `storagePath` values, which would otherwise raise a
  // raw TypeError in `String.prototype.includes` and surface as HTTP 500.
  describe('non-string inputs', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['boolean', true],
      ['object', { foo: 'bar' }],
      ['array', ['a', 'b']],
    ])('should reject %s with PathValidationError', (_label, value) => {
      expect(() => validateStoragePath(value as unknown as string)).toThrow('must be a string');
    });
  });

  // Aligns with the S3 object key size limit (1024 UTF-8 bytes).
  describe('maximum length', () => {
    it('should accept an ASCII path of exactly 1024 bytes', () => {
      const path = 'a'.repeat(1024);
      expect(() => validateStoragePath(path)).not.toThrow();
    });

    it('should reject an ASCII path of 1025 bytes', () => {
      const path = 'a'.repeat(1025);
      expect(() => validateStoragePath(path)).toThrow('exceeds maximum length of 1024 bytes');
    });

    it('should measure length in UTF-8 bytes (multibyte characters)', () => {
      // 'あ' is 3 bytes in UTF-8.
      expect(() => validateStoragePath('あ'.repeat(341))).not.toThrow(); // 1023 bytes
      expect(() => validateStoragePath('あ'.repeat(342))).toThrow(
        'exceeds maximum length of 1024 bytes'
      ); // 1026 bytes
    });
  });
});
