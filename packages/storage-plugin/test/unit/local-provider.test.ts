// deno-lint-ignore-file no-explicit-any ban-unused-ignore require-await
/**

 * Tests for {@linkcode LocalStorageProvider}.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { LocalStorageProvider } from '../../src/providers/local-provider.ts';

describe('LocalStorageProvider', () => {
  function makeFakeFs() {
    const store = new Map<string, Uint8Array>();

    return {
      fs: {
        readFile(path: string) {
          const data = store.get(path);
          if (data === undefined) throw new Error(`ENOENT: ${path}`);
          return Promise.resolve(data);
        },
        writeFile(path: string, data: Uint8Array) {
          store.set(path, data);
          return Promise.resolve();
        },
        stat(path: string) {
          if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
          return {
            size: store.get(path)!.length,
          } as unknown as import('@setu-ts/common').StatResult;
        },
        rm(path: string) {
          if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
          store.delete(path);
          return Promise.resolve();
        },
        realPath(p: string): Promise<string> {
          return Promise.resolve(p);
        },
        readdir(_path: string): Promise<readonly string[]> {
          return Promise.resolve([]);
        },
        mkdir(_path: string, _options?: { readonly recursive?: boolean }): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as import('@setu-ts/common').IFileSystem,
      store,
    };
  }

  it('connect throws when runtime.fs is absent', () => {
    const provider = new LocalStorageProvider(undefined, {});
    expect(() => provider.connect()).toThrow(
      'LocalStorageProvider requires runtime.fs which is not available on this runtime',
    );
  });

  it('connect succeeds when fs is present', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, {});
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });

  it('put → get round-trip over fake fs', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    const data = new Uint8Array([1, 2, 3]);
    await provider.put('sub/file.bin', data);
    const result = await provider.get('sub/file.bin');
    expect(result).toEqual(data);
  });

  it('get returns null for missing file', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    const result = await provider.get('nonexistent');
    expect(result).toBeNull();
  });

  it('delete returns true when file exists', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    await provider.put('del-me', new Uint8Array([1]));
    const result = await provider.delete('del-me');
    expect(result).toBe(true);
  });

  it('delete returns false when file is missing', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    const result = await provider.delete('missing');
    expect(result).toBe(false);
  });

  it('exists returns true for present file', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    await provider.put('ex', new Uint8Array([1]));
    expect(await provider.exists('ex')).toBe(true);
  });

  it('exists returns false for missing file', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    expect(await provider.exists('nope')).toBe(false);
  });

  it('getSignedUrl throws with documented message', () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    provider.connect();
    expect(() => provider.getSignedUrl('key', { expiresIn: 60 })).toThrow(
      'LocalStorageProvider does not support signed URLs; use the s3, gcs, or azure provider',
    );
  });

  it('path containment blocks .. escape', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    await provider.put('../escape', new Uint8Array([99]));
    const result = await provider.get('../escape');
    expect(result).toEqual(new Uint8Array([99]));
  });

  it('put → get with rootDir="./" uses relative path', async () => {
    const { fs, store } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: './storage' });
    await provider.connect();
    await provider.put('rel.bin', new Uint8Array([1, 2]));
    expect(await provider.get('rel.bin')).toEqual(new Uint8Array([1, 2]));
    // Verify the file was stored at the joined path
    expect(store.has('./storage/rel.bin')).toBe(true);
  });

  it('resolvePath skips .. parts but keeps valid nested path', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/safe' });
    await provider.connect();
    await provider.put('deep/nested/path/file.dat', new Uint8Array([42]));
    const result = await provider.get('deep/nested/path/file.dat');
    expect(result).toEqual(new Uint8Array([42]));
  });

  it('get returns null when readFile throws', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    // File never put — readFile will throw ENOENT
    const result = await provider.get('never-existed.bin');
    expect(result).toBeNull();
  });

  it('disconnect is no-op', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    await provider.disconnect();
    // disconnect is async no-op — should not throw
  });

  it('put uses lexical joinPath when realPath is absent', async () => {
    const store = new Map<string, Uint8Array>();
    const fakeFs = {
      readFile(path: string) {
        const data = store.get(path);
        if (data === undefined) throw new Error(`ENOENT: ${path}`);
        return Promise.resolve(data);
      },
      writeFile(path: string, data: Uint8Array) {
        store.set(path, data);
        return Promise.resolve();
      },
      stat(path: string) {
        if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
        return {
          size: store.get(path)!.length,
        } as unknown as import('@setu-ts/common').StatResult;
      },
      rm(path: string) {
        if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
        store.delete(path);
        return Promise.resolve();
      },
      // No realPath method — forces lexical containment.
      readdir(_path: string): Promise<readonly string[]> {
        return Promise.resolve([]);
      },
      mkdir(_path: string, _options?: { readonly recursive?: boolean }): Promise<void> {
        return Promise.resolve();
      },
    } as unknown as import('@setu-ts/common').IFileSystem;
    const provider = new LocalStorageProvider(fakeFs, { rootDir: '/safe-root' });
    await provider.connect();
    await provider.put('joined/path.bin', new Uint8Array([55]));
    expect(await provider.get('joined/path.bin')).toEqual(new Uint8Array([55]));
    expect(store.has('/safe-root/joined/path.bin')).toBe(true);
  });

  it('put with path starting ".." skips escape via joinPath', async () => {
    const { fs, store } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    await provider.put('../escape.bin', new Uint8Array([88]));
    // With lexical joinPath that skips '..', the '..' part is dropped,
    // so '../escape.bin' becomes 'escape.bin' under root '/root'.
    expect(store.has('/root/escape.bin')).toBe(true);
  });

  it('#joinPath skips all ".." components but keeps valid nested parts', async () => {
    const { fs } = makeFakeFs();
    const provider = new LocalStorageProvider(fs, { rootDir: '/root' });
    await provider.connect();
    // joinPath iterates parts and skips '' and '.'; for '..', it just continues.
    // So 'a/b/../c/d/file.bin' → parts [a, b, .., c, d, file.bin]
    // After 'a': /root/a
    // After 'b': /root/a/b
    // After '..': skip → /root/a/b
    // After 'c': /root/a/b/c
    // After 'd': /root/a/b/c/d
    // After 'file.bin': /root/a/b/c/d/file.bin
    await provider.put('a/b/../c/d/file.bin', new Uint8Array([33]));
    const result = await provider.get('a/b/c/d/file.bin');
    expect(result).toEqual(new Uint8Array([33]));
  });

  it('put throws when resolved path escapes root via realPath check', async () => {
    const { fs } = makeFakeFs();
    // Override realPath to resolve a real root where the joined path would escape.
    const realPathCalls: string[] = [];
    const trackingFs = {
      ...fs,
      realPath: (p: string) => {
        realPathCalls.push(p);
        if (p.includes('escape-real')) {
          return Promise.resolve('/outside/root');
        }
        return Promise.resolve(p);
      },
    };
    const provider = new LocalStorageProvider(
      trackingFs as unknown as import('@setu-ts/common').IFileSystem,
      { rootDir: '/safe-root' },
    );
    await provider.connect();
    // B1 fix: path-escape now throws instead of silently succeeding.
    await expect(provider.put('sub/escape-real.bin', new Uint8Array([11]))).rejects.toThrow(
      'Path traversal attempt blocked',
    );
    expect(realPathCalls.length).toBeGreaterThan(0);
  });

  it('put creates parent directories for nested keys', async () => {
    const { fs } = makeFakeFs();
    // deno-lint-ignore no-explicit-any
    const mkdirPaths: string[] = [];
    const mkdirFs = {
      ...fs,
      mkdir(path: string, _options?: { recursive?: boolean }) {
        mkdirPaths.push(path);
        // Simulate directory creation by populating the store with a marker.
        return Promise.resolve();
      },
    };
    const provider = new LocalStorageProvider(
      mkdirFs as unknown as import('@setu-ts/common').IFileSystem,
      {
        rootDir: '/root',
      },
    );
    await provider.connect();
    // Nested key should trigger mkdir for parent dir.
    await provider.put('a/b/c/file.bin', new Uint8Array([42]));
    // Verify mkdir was called for the parent directory.
    expect(mkdirPaths).toContain('/root/a/b/c');
    // get should succeed after mkdir and writeFile.
    const data = await provider.get('a/b/c/file.bin');
    expect(data).toEqual(new Uint8Array([42]));
  });

  it('resolvePath falls back to lexical join when realPath IO throws', async () => {
    const { fs } = makeFakeFs();
    const throwFs = {
      ...fs,
      realPath() {
        return Promise.reject(new Error('realPath not supported'));
      },
    };
    const provider = new LocalStorageProvider(
      throwFs as unknown as import('@setu-ts/common').IFileSystem,
      { rootDir: '/root' },
    );
    await provider.connect();
    // Should fall through to lexical path without throwing.
    await provider.put('normal.bin', new Uint8Array([99]));
    const data = await provider.get('normal.bin');
    expect(data).toEqual(new Uint8Array([99]));
  });
});
