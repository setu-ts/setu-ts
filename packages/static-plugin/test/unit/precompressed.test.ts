import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  findPrecompressedSidecar,
  getOriginalContentType,
  isEncodingAcceptable,
  parseAcceptEncoding,
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

  it('should respect quality values', () => {
    expect(isEncodingAcceptable('gzip;q=0.5, br;q=1.0', 'br')).toBe(true);
    expect(isEncodingAcceptable('gzip;q=0.5, br;q=1.0', 'gz')).toBe(true);
  });

  it('should reject q=0 encoding', () => {
    expect(isEncodingAcceptable('gzip;q=0', 'gz')).toBe(false);
    expect(isEncodingAcceptable('gzip;q=0, br', 'gz')).toBe(false);
  });

  it('should accept identity when explicitly listed', () => {
    expect(isEncodingAcceptable('identity', 'br')).toBe(false);
    expect(isEncodingAcceptable('identity, gzip', 'gz')).toBe(true);
  });
});

describe('parseAcceptEncoding', () => {
  it('should parse simple encoding', () => {
    const result = parseAcceptEncoding('gzip');
    expect(result).toEqual([{ encoding: 'gzip', quality: 1.0 }]);
  });

  it('should parse multiple encodings', () => {
    const result = parseAcceptEncoding('gzip, br');
    expect(result).toHaveLength(2);
    expect(result[0].encoding).toBe('gzip');
    expect(result[1].encoding).toBe('br');
  });

  it('should parse quality values', () => {
    const result = parseAcceptEncoding('gzip;q=0.5, br;q=1.0');
    expect(result).toEqual([
      { encoding: 'br', quality: 1.0 },
      { encoding: 'gzip', quality: 0.5 },
    ]);
  });

  it('should sort by quality descending', () => {
    const result = parseAcceptEncoding('br;q=0.3, gzip;q=0.8, identity');
    expect(result.map((e) => e.encoding)).toEqual(['identity', 'gzip', 'br']);
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

  it('should use sidecar ETag for conditional responses', async () => {
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
      acceptEncoding: 'br',
    });
    expect(result).not.toBeNull();
    expect(result!.stat.size).toBe(50);
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
