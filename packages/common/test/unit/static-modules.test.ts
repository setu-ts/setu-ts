import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { contentTypeFor } from '../../src/static/content-types.ts';
import {
  assertRealPathContained,
  isLexicallyContained,
} from '../../src/static/path-containment.ts';

describe('content-types', () => {
  it('should return correct content type for known extensions', () => {
    expect(contentTypeFor('test.js')).toBe('text/javascript');
    expect(contentTypeFor('test.css')).toBe('text/css');
    expect(contentTypeFor('test.html')).toBe('text/html');
    expect(contentTypeFor('test.json')).toBe('application/json');
    expect(contentTypeFor('test.png')).toBe('image/png');
  });

  it('should be case-insensitive', () => {
    expect(contentTypeFor('test.JS')).toBe('text/javascript');
    expect(contentTypeFor('test.CSS')).toBe('text/css');
  });

  it('should return octet-stream for unknown extensions', () => {
    expect(contentTypeFor('test.unknown')).toBe('application/octet-stream');
  });

  it('should return octet-stream for no extension', () => {
    expect(contentTypeFor('test')).toBe('application/octet-stream');
  });
});

describe('path-containment', () => {
  describe('isLexicallyContained', () => {
    it('should reject path traversal', () => {
      expect(isLexicallyContained('../etc/passwd')).toBe(false);
      expect(isLexicallyContained('foo/../../bar')).toBe(false);
    });

    it('should reject absolute paths', () => {
      expect(isLexicallyContained('/etc/passwd')).toBe(false);
      expect(isLexicallyContained('\\etc\\passwd')).toBe(false);
    });

    it('should accept normal paths', () => {
      expect(isLexicallyContained('test.txt')).toBe(true);
      expect(isLexicallyContained('foo/bar.txt')).toBe(true);
    });

    it('should reject empty paths but accept root', () => {
      expect(isLexicallyContained('')).toBe(false);
      expect(isLexicallyContained('/')).toBe(true);
    });
  });

  describe('assertRealPathContained', () => {
    it('should return true for paths inside root', async () => {
      const fs = {
        realPath: (path: string) => Promise.resolve(path.replace('/root', '/canonical/root')),
        stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      };

      const result = await assertRealPathContained(
        fs,
        '/canonical/root',
        '/canonical/root/test.txt',
      );
      expect(result).toBe(true);
    });

    it('should return false for paths outside root', async () => {
      const fs = {
        realPath: (path: string) => {
          if (path.includes('escape')) {
            return Promise.resolve('/outside/root');
          }
          return Promise.resolve('/canonical/root');
        },
        stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      };

      const result = await assertRealPathContained(
        fs,
        '/canonical/root',
        '/canonical/root/escape.txt',
      );
      expect(result).toBe(false);
    });

    it('should fall back to lexical check when realPath is absent', async () => {
      const fs = {
        stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 0 }),
      };

      const result = await assertRealPathContained(fs, '/root', '/root/test.txt');
      expect(result).toBe(true);
    });
  });
});
