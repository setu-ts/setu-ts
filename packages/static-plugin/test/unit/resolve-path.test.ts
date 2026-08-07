import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolvePath } from '../../src/handler/resolve-path.ts';

describe('resolvePath', () => {
  const fs = {
    stat: (path: string) => {
      if (path.endsWith('/index.html')) {
        return Promise.resolve({ isFile: true, isDirectory: false, size: 100 });
      }
      if (path.endsWith('/')) {
        return Promise.resolve({ isFile: false, isDirectory: true, size: 0 });
      }
      throw new Error('ENOENT');
    },
    readFile: () => Promise.resolve(new Uint8Array()),
    writeFile: () => Promise.resolve(),
    readdir: () => Promise.resolve([]),
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    realPath: (path: string) => Promise.resolve(path),
  };

  it('should strip URL prefix', async () => {
    const result = await resolvePath(
      { fs, root: '/root', urlPrefix: '/assets', index: 'index.html' },
      '/assets/test.txt',
    );
    expect(result).toBeNull();
  });

  it('should resolve directory to index file', async () => {
    const result = await resolvePath(
      { fs, root: '/root', urlPrefix: '/', index: 'index.html' },
      '/',
    );
    expect(result).toBe('/root/index.html');
  });

  it('should return null for missing file', async () => {
    const result = await resolvePath(
      { fs, root: '/root', urlPrefix: '/', index: 'index.html' },
      '/missing.txt',
    );
    expect(result).toBeNull();
  });

  it('should reject path traversal', async () => {
    const result = await resolvePath(
      { fs, root: '/root', urlPrefix: '/', index: 'index.html' },
      '/../etc/passwd',
    );
    expect(result).toBeNull();
  });

  it('should disable index when index is empty string', async () => {
    const result = await resolvePath(
      { fs, root: '/root', urlPrefix: '/', index: '' },
      '/',
    );
    expect(result).toBe('/root');
  });

  it('should serve fallback for missing file with HTML accept', async () => {
    const fsWithFallback = {
      stat: (path: string) => {
        if (path.endsWith('/fallback.html')) {
          return Promise.resolve({ isFile: true, isDirectory: false, size: 100 });
        }
        throw new Error('ENOENT');
      },
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path: string) => Promise.resolve(path),
    };

    const result = await resolvePath(
      {
        fs: fsWithFallback,
        root: '/root',
        urlPrefix: '/',
        index: 'index.html',
        fallback: 'fallback.html',
      },
      '/missing.txt',
    );
    expect(result).toBe('/root/fallback.html');
  });

  it('should not serve fallback for non-HTML accept', async () => {
    const fsWithFallback = {
      stat: (path: string) => {
        if (path.endsWith('/fallback.html')) {
          return Promise.resolve({ isFile: true, isDirectory: false, size: 100 });
        }
        throw new Error('ENOENT');
      },
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path: string) => Promise.resolve(path),
    };

    const result = await resolvePath(
      {
        fs: fsWithFallback,
        root: '/root',
        urlPrefix: '/',
        index: 'index.html',
        fallback: 'fallback.html',
      },
      '/missing.js',
    );
    expect(result).toBeNull();
  });
});
