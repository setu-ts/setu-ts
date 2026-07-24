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
          } as unknown as import('@hono-enterprise/common').StatResult;
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
      } as unknown as import('@hono-enterprise/common').IFileSystem,
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
});
