import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem } from '@setu-ts/common';
import { LocalStorageProvider } from '../../../src/providers/local-provider.ts';

/**
 * An fs whose `stat` succeeds for paths in `present` and throws for everything
 * else, exercising the `stat(root)` probe.
 *
 * It also implements the write path, because `connect()` now proves the root is
 * writable (X8-9). `writable: false` reproduces the case that made X8-9 hard to
 * see: the root READS fine, so a stat-only probe reported `up` while every
 * upload failed.
 */
function makeFs(present: ReadonlySet<string>, writable = true): IFileSystem {
  const denied = (path: string) =>
    Promise.reject(new Error(`PermissionDenied: Requires write access to "${path}"`));
  const fs: Record<string, unknown> = {
    stat: (path: string) => {
      if (!present.has(path)) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve({ size: 0 });
    },
    mkdir: (path: string) => (writable ? Promise.resolve() : denied(path)),
    writeFile: (path: string) => (writable ? Promise.resolve() : denied(path)),
    rm: () => Promise.resolve(),
  };
  return fs as unknown as IFileSystem;
}

/**
 * A writable fs that records every path handed to `writeFile`, so a test can
 * see the probe path the provider chose. `rm` is replaceable so the
 * cleanup-failure branch can be driven.
 */
function writableFs(written: string[]): IFileSystem & { rm: (path: string) => Promise<void> } {
  const fs = {
    stat: () => Promise.resolve({ size: 0 }),
    mkdir: () => Promise.resolve(),
    writeFile: (path: string) => {
      written.push(path);
      return Promise.resolve();
    },
    rm: () => Promise.resolve(),
  };
  return fs as unknown as IFileSystem & { rm: (path: string) => Promise<void> };
}

describe('LocalStorageProvider health (M70c)', () => {
  it('is reachable while stat(root) succeeds', async () => {
    const provider = new LocalStorageProvider(makeFs(new Set(['/data'])), { rootDir: '/data' });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
  });

  it('is unreachable when the root is removed', async () => {
    const present = new Set(['/data']);
    const provider = new LocalStorageProvider(makeFs(present), { rootDir: '/data' });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
    // Simulate the disk/directory vanishing.
    present.delete('/data');
    expect(await provider.isHealthy()).toBe(false);
  });

  it('is unreachable before connect when fs is absent', async () => {
    const provider = new LocalStorageProvider(undefined, { rootDir: '/data' });
    expect(provider.isReady()).toBe(false);
    expect(await provider.isHealthy()).toBe(false);
  });

  it('refuses to connect when the root is readable but NOT writable (X8-9)', async () => {
    // The exact state a scaffolded Deno project was in: `--allow-read` granted,
    // `--allow-write` not. Every upload failed and `/health` said `up`.
    const provider = new LocalStorageProvider(
      makeFs(new Set(['/data']), false),
      { rootDir: '/data' },
      () => 'deno',
    );

    await expect(provider.connect()).rejects.toThrow("cannot write to '/data'");
  });

  it('names --allow-write on Deno, and does not on other runtimes', async () => {
    const denoProvider = new LocalStorageProvider(
      makeFs(new Set(['/data']), false),
      { rootDir: '/data' },
      () => 'deno',
    );
    await expect(denoProvider.connect()).rejects.toThrow('--allow-write');

    // On Node the same failure is a real file permission, which that flag does
    // not address — naming it there would send the reader down a dead end.
    const nodeProvider = new LocalStorageProvider(
      makeFs(new Set(['/data']), false),
      { rootDir: '/data' },
      () => 'node',
    );
    const error = await nodeProvider.connect().then(
      () => null,
      (raised: unknown) => raised as Error,
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain("cannot write to '/data'");
    expect(error?.message).not.toContain('--allow-write');
  });

  it('reports unhealthy when the root never proved writable', async () => {
    // A stat-only probe answered `up` here, which is what hid the cause.
    const provider = new LocalStorageProvider(makeFs(new Set(['/data']), false), {
      rootDir: '/data',
    });
    await provider.connect().catch(() => {});

    expect(await provider.isHealthy()).toBe(false);
  });
});

describe('LocalStorageProvider — the write probe under a shared root', () => {
  it('should use a unique probe path per connect, so two replicas cannot collide', async () => {
    // Two processes sharing one volume connect concurrently. With a fixed probe
    // name whichever `rm` ran second failed with ENOENT and refused to boot a
    // process whose root was perfectly writable.
    const written: string[] = [];
    const fs = writableFs(written);

    await new LocalStorageProvider(fs, { rootDir: '/data' }).connect();
    await new LocalStorageProvider(fs, { rootDir: '/data' }).connect();

    const probes = written.filter((path) => path.includes('.setu-write-probe'));
    expect(probes).toHaveLength(2);
    expect(probes[0]).not.toBe(probes[1]);
  });

  it('should still start when the probe cannot be cleaned up', async () => {
    // The write is what proves writability. A root that accepts the write but
    // refuses the unlink — or whose sibling replica already removed it — is
    // writable, and refusing to boot there would be a false negative.
    const fs = writableFs([]);
    fs.rm = () => Promise.reject(new Error('ENOENT: no such file or directory'));

    const provider = new LocalStorageProvider(fs, { rootDir: '/data' });
    await provider.connect();

    await expect(provider.isHealthy()).resolves.toBe(true);
  });
});
