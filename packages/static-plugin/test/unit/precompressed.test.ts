import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  findPrecompressedSidecar,
  getOriginalContentType,
  isEncodingAcceptable,
} from '../../src/http/precompressed.ts';

describe('isEncodingAcceptable', () => {
  it('should accept br when present', () => {
    expect(isEncodingAcceptable('gzip, br', 'br')).toBe(true);
  });

  it('should accept gzip when present', () => {
    expect(isEncodingAcceptable('gzip, br', 'gz')).toBe(true);
  });

  it('should reject when not present', () => {
    expect(isEncodingAcceptable('gzip', 'br')).toBe(false);
  });

  it('should accept any encoding with wildcard', () => {
    expect(isEncodingAcceptable('*', 'br')).toBe(true);
  });

  it('should handle empty encoding list', () => {
    expect(isEncodingAcceptable('', 'br')).toBe(false);
  });

  it('should handle whitespace in encodings', () => {
    expect(isEncodingAcceptable('  gzip  ,  br  ', 'br')).toBe(true);
  });
});

describe('findPrecompressedSidecar', () => {
  const fs = {
    stat: (path: string) => {
      if (path.endsWith('.br')) {
        return Promise.resolve({ isFile: true, isDirectory: false, size: 50 });
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

  it('should prefer brotli over gzip', async () => {
    const result = await findPrecompressedSidecar({
      fs,
      originalPath: '/root/test.js',
      originalStat: { isFile: true, isDirectory: false, size: 100 },
      acceptEncoding: 'gzip, br',
    });
    expect(result).not.toBeNull();
    expect(result!.format).toBe('br');
  });

  it('should return null when no sidecar exists', async () => {
    const fsNoSidecar = {
      stat: () => {
        throw new Error('ENOENT');
      },
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      realPath: (path: string) => Promise.resolve(path),
    };

    const result = await findPrecompressedSidecar({
      fs: fsNoSidecar,
      originalPath: '/root/test.js',
      originalStat: { isFile: true, isDirectory: false, size: 100 },
      acceptEncoding: 'gzip, br',
    });
    expect(result).toBeNull();
  });

  it('should return null when accept-encoding is absent', async () => {
    const result = await findPrecompressedSidecar({
      fs,
      originalPath: '/root/test.js',
      originalStat: { isFile: true, isDirectory: false, size: 100 },
    });
    expect(result).toBeNull();
  });

  it('should use sidecar stat for ETag', async () => {
    const result = await findPrecompressedSidecar({
      fs,
      originalPath: '/root/test.js',
      originalStat: { isFile: true, isDirectory: false, size: 100 },
      acceptEncoding: 'br',
    });
    expect(result).not.toBeNull();
    expect(result!.stat.size).toBe(50);
  });

  it('should fall back to gzip when brotli is not available', async () => {
    const fsGzOnly = {
      stat: (path: string) => {
        if (path.endsWith('.gz')) {
          return Promise.resolve({ isFile: true, isDirectory: false, size: 60 });
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

    const result = await findPrecompressedSidecar({
      fs: fsGzOnly,
      originalPath: '/root/test.js',
      originalStat: { isFile: true, isDirectory: false, size: 100 },
      acceptEncoding: 'gzip, br',
    });
    expect(result).not.toBeNull();
    expect(result!.format).toBe('gz');
  });

  it('should return null when sidecar exists but encoding is not acceptable', async () => {
    const fsBrOnly = {
      stat: (path: string) => {
        if (path.endsWith('.br')) {
          return Promise.resolve({ isFile: true, isDirectory: false, size: 50 });
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

    const result = await findPrecompressedSidecar({
      fs: fsBrOnly,
      originalPath: '/root/test.js',
      originalStat: { isFile: true, isDirectory: false, size: 100 },
      acceptEncoding: 'gzip',
    });
    expect(result).toBeNull();
  });
});

describe('getOriginalContentType', () => {
  it('should return the content type for the original path', () => {
    const contentType = getOriginalContentType('/root/test.js');
    expect(contentType).toBe('text/javascript');
  });

  it('should return application/octet-stream for unknown extensions', () => {
    const contentType = getOriginalContentType('/root/test.unknown');
    expect(contentType).toBe('application/octet-stream');
  });
});
