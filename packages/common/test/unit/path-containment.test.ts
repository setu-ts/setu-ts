import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  assertRealPathContained,
  isLexicallyContained,
} from '../../src/static/path-containment.ts';

describe('isLexicallyContained', () => {
  it('should reject empty paths', () => {
    expect(isLexicallyContained('')).toBe(false);
  });

  it('should allow root path', () => {
    expect(isLexicallyContained('/')).toBe(true);
  });

  it('should allow simple relative paths', () => {
    expect(isLexicallyContained('test.txt')).toBe(true);
    expect(isLexicallyContained('dir/file.txt')).toBe(true);
  });

  it('should reject path traversal', () => {
    expect(isLexicallyContained('../etc/passwd')).toBe(false);
    expect(isLexicallyContained('dir/../../etc/passwd')).toBe(false);
    expect(isLexicallyContained('..')).toBe(false);
  });

  it('should reject absolute paths', () => {
    expect(isLexicallyContained('/etc/passwd')).toBe(false);
    expect(isLexicallyContained('\\etc\\passwd')).toBe(false);
  });

  it('should reject encoded traversal', () => {
    expect(isLexicallyContained('%2e%2e/etc/passwd')).toBe(false);
  });
});

describe('assertRealPathContained', () => {
  it('should return true for paths within root via lexical check', async () => {
    const fs = {
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
    };
    const result = await assertRealPathContained(fs as never, '/root', '/root/subdir/file.txt');
    expect(result).toBe(true);
  });

  it('should return false for paths outside root via lexical check', async () => {
    const fs = {
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
    };
    const result = await assertRealPathContained(fs as never, '/root', '/other/file.txt');
    expect(result).toBe(false);
  });

  it('should use realPath when available', async () => {
    const fs = {
      realPath: (path: string) => Promise.resolve(path.replace('/root', '/real-root')),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
    };
    const result = await assertRealPathContained(fs as never, '/root', '/root/file.txt');
    expect(result).toBe(true);
  });

  it('should return false when realPath throws', async () => {
    const fs = {
      realPath: () => Promise.reject(new Error('ENOENT')),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
    };
    const result = await assertRealPathContained(fs as never, '/root', '/root/file.txt');
    expect(result).toBe(false);
  });

  it('should return true when target equals root', async () => {
    const fs = {
      realPath: (path: string) => Promise.resolve(path),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
    };
    const result = await assertRealPathContained(fs as never, '/root', '/root');
    expect(result).toBe(true);
  });

  it('should handle trailing slash in root', async () => {
    const fs = {
      realPath: (path: string) => Promise.resolve(path),
      stat: () => Promise.resolve({ isFile: true, isDirectory: false, size: 10 }),
    };
    const result = await assertRealPathContained(fs as never, '/root/', '/root/subdir/file.txt');
    expect(result).toBe(true);
  });
});
