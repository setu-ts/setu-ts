import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem } from '@setu-ts/common';
import { LocalStorageProvider } from '../../../src/providers/local-provider.ts';

/**
 * A minimal fs whose `stat` succeeds for paths in `present` and throws for
 * everything else — enough to exercise the `stat(root)` probe.
 */
function makeFs(present: ReadonlySet<string>): IFileSystem {
  const fs: Record<string, unknown> = {
    stat: (path: string) => {
      if (!present.has(path)) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve({ size: 0 });
    },
  };
  return fs as unknown as IFileSystem;
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
});
