import { describe, it, expect } from 'vitest';
import { guessContentType } from '../src/content-type.js';

describe('guessContentType', () => {
  describe('text files (with charset)', () => {
    it.each([
      ['file.txt', 'text/plain; charset=utf-8'],
      ['README.md', 'text/markdown; charset=utf-8'],
      ['data.csv', 'text/csv; charset=utf-8'],
      ['index.html', 'text/html; charset=utf-8'],
      ['style.css', 'text/css; charset=utf-8'],
      ['config.xml', 'application/xml; charset=utf-8'],
    ])('%s → %s', (filename, expected) => {
      expect(guessContentType(filename)).toBe(expected);
    });
  });

  describe('programming languages (with charset)', () => {
    it.each([
      ['app.js', 'application/javascript; charset=utf-8'],
      ['app.mjs', 'application/javascript; charset=utf-8'],
      ['app.ts', 'application/typescript; charset=utf-8'],
      ['app.tsx', 'application/typescript; charset=utf-8'],
      ['data.json', 'application/json; charset=utf-8'],
      ['script.py', 'text/x-python; charset=utf-8'],
      ['Main.java', 'text/x-java; charset=utf-8'],
      ['main.go', 'text/x-go; charset=utf-8'],
      ['main.rs', 'text/x-rust; charset=utf-8'],
      ['main.c', 'text/x-c; charset=utf-8'],
      ['main.cpp', 'text/x-c++src; charset=utf-8'],
      ['main.rb', 'text/x-ruby; charset=utf-8'],
      ['run.sh', 'application/x-sh; charset=utf-8'],
      ['query.sql', 'application/sql; charset=utf-8'],
    ])('%s → %s', (filename, expected) => {
      expect(guessContentType(filename)).toBe(expected);
    });
  });

  describe('config files (with charset)', () => {
    it.each([
      ['config.yaml', 'application/x-yaml; charset=utf-8'],
      ['config.yml', 'application/x-yaml; charset=utf-8'],
      ['config.toml', 'application/toml; charset=utf-8'],
      ['config.ini', 'text/plain; charset=utf-8'],
      ['nginx.conf', 'text/plain; charset=utf-8'],
      ['.env', 'text/plain; charset=utf-8'],
    ])('%s → %s', (filename, expected) => {
      expect(guessContentType(filename)).toBe(expected);
    });
  });

  describe('binary files (no charset)', () => {
    it.each([
      ['doc.pdf', 'application/pdf'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['icon.png', 'image/png'],
      ['anim.gif', 'image/gif'],
      ['logo.svg', 'image/svg+xml'],
      ['image.webp', 'image/webp'],
      ['archive.zip', 'application/zip'],
      ['backup.tar', 'application/x-tar'],
      ['backup.gz', 'application/gzip'],
      ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['video.mp4', 'video/mp4'],
      ['audio.mp3', 'audio/mpeg'],
      ['font.woff2', 'font/woff2'],
    ])('%s → %s', (filename, expected) => {
      expect(guessContentType(filename)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('returns octet-stream for unknown extensions', () => {
      expect(guessContentType('file.xyz')).toBe('application/octet-stream');
    });

    it('returns octet-stream for no extension', () => {
      expect(guessContentType('Makefile')).toBe('application/octet-stream');
    });

    it('handles paths with directories', () => {
      expect(guessContentType('src/components/App.tsx')).toBe('application/typescript; charset=utf-8');
    });

    it('handles case-insensitive extensions', () => {
      expect(guessContentType('image.PNG')).toBe('image/png');
      expect(guessContentType('style.CSS')).toBe('text/css; charset=utf-8');
    });
  });
});
