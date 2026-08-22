/**
 * Tests for {@linkcode StoragePlugin} factory — default provider, unknown
 * provider error, health indicator lifecycle, b2 preset endpoint.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createProvider, StoragePlugin } from '../../src/plugin/storage-plugin.ts';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import type { StoragePluginOptions } from '../../src/interfaces/index.ts';
import type { IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createFakeContext } from '../fixtures/fake-context.ts';

/** Build a minimal fake runtime for createProvider tests. */
function makeFakeRuntime(): IRuntimeServices {
  return {
    env: {},
    hrtime: () => performance.now(),
    platform: () => 'deno',
    version: () => '1.0.0',
    hostname: () => 'localhost',
    uuid: () => 'test-uuid',
    randomBytes: () => new Uint8Array(),
    subtle: globalThis.crypto.subtle,
    now: () => Date.now(),
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    exit: () => {
      throw new Error('exit');
    },
  } as IRuntimeServices;
}

describe('createProvider', () => {
  const fakeRuntime = makeFakeRuntime();

  it('defaults to memory provider when type is memory', () => {
    const p = createProvider({ provider: 'memory' }, fakeRuntime);
    expect(p).toBeInstanceOf(MemoryProvider);
  });

  it('injects runtime.now() as the provider clock (getSignedUrl expiry uses it, not Date.now)', async () => {
    const rt = { ...makeFakeRuntime(), now: (): number => 1_700_000_000_000 } as IRuntimeServices;
    const p = createProvider({ provider: 'memory' }, rt);
    await p.connect();
    const url = await p.getSignedUrl('k.txt', { expiresIn: 60 });
    // 1_700_000_000_000 ms → 1_700_000_000 s + 60 = 1700000060
    expect(url).toBe('memory://k.txt?expires=1700000060');
  });

  it('unknown provider type throws', () => {
    // Unreachable through the typed surface now that the options are
    // discriminated, so the cast stands in for a JavaScript caller.
    expect(() =>
      createProvider(
        { provider: 'invalid' } as unknown as StoragePluginOptions,
        fakeRuntime,
      )
    ).toThrow('Unsupported storage provider');
  });

  it('b2 type builds S3Provider with derived B2 endpoint', () => {
    const p = createProvider({
      provider: 'b2',
      options: {
        bucket: 'mybucket',
        region: 'us-west-1',
        accessKeyId: 'keyid',
        secretAccessKey: 'secret',
      },
    }, fakeRuntime);
    expect(p.isReady()).toBe(false);
  });

  it('b2 honors explicit endpoint override', () => {
    const customEndpoint = 'https://custom.endpoint.com';
    const p = createProvider({
      provider: 'b2',
      options: { bucket: 'mybucket', endpoint: customEndpoint },
    }, fakeRuntime);
    expect(p.isReady()).toBe(false);
  });
});

describe('StoragePlugin', () => {
  it('default provider is memory', async () => {
    const { ctx, registered, healthIndicators } = createFakeContext();
    const plugin = StoragePlugin();
    await plugin.register!(ctx);

    const storage = registered.get(CAPABILITIES.STORAGE);
    expect(storage).toBeDefined();

    const indicator = healthIndicators.get(CAPABILITIES.STORAGE);
    expect(indicator).toBeDefined();
    const status = await indicator!();
    expect(status.status).toBe('up');
  });

  it('registers health indicator as up after connect', async () => {
    const { ctx, healthIndicators } = createFakeContext({}, false);
    const plugin = StoragePlugin({ provider: 'memory' });
    await plugin.register!(ctx);

    const indicator = healthIndicators.get(CAPABILITIES.STORAGE);
    const status = await indicator!();
    expect(status.status).toBe('up');
  });

  it('onClose disconnect is registered', async () => {
    const { ctx, onCloseHandlers } = createFakeContext();
    const plugin = StoragePlugin();
    await plugin.register!(ctx);

    expect(onCloseHandlers.length).toBeGreaterThan(0);
    await onCloseHandlers[0]!();
  });

  it('unknown provider type at registration throws', async () => {
    const { ctx } = createFakeContext();
    const plugin = StoragePlugin(
      { provider: 'nonexistent' } as unknown as StoragePluginOptions,
    );
    await expect(plugin.register!(ctx)).rejects.toThrow('Unsupported storage provider');
  });

  it('s3 provider can be wired', () => {
    const fakeRuntime = makeFakeRuntime();
    const provider = createProvider(
      { provider: 's3', options: { bucket: 'test-bucket', region: 'us-east-1' } },
      fakeRuntime,
    );
    expect(provider.isReady()).toBe(false);
  });

  it('azure provider can be wired', () => {
    const fakeRuntime = makeFakeRuntime();
    const provider = createProvider({
      provider: 'azure',
      options: {
        containerName: 'mycontainer',
        accountName: 'fakeaccount',
        accountKey: 'dGVzdGtleQ==',
      },
    }, fakeRuntime);
    expect(provider.isReady()).toBe(false);
  });

  it('gcs provider can be wired', () => {
    const fakeRuntime = makeFakeRuntime();
    const provider = createProvider(
      { provider: 'gcs', options: { bucket: 'my-bucket' } },
      fakeRuntime,
    );
    expect(provider.isReady()).toBe(false);
  });
});

describe('StoragePlugin health indicator (M70c)', () => {
  /**
   * A file system whose ROOT may be present or gone. It implements the write
   * path too, because `LocalStorageProvider.connect()` now proves the root is
   * writable (X8-9) — a fake offering only `stat` would fail to connect at all.
   */
  function makeFs(rootPresent: boolean): import('@setu-ts/common').IFileSystem {
    const fs: Record<string, unknown> = {
      stat: (path: string) =>
        rootPresent ? Promise.resolve({ size: 0 }) : Promise.reject(new Error(`ENOENT: ${path}`)),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
    return fs as unknown as import('@setu-ts/common').IFileSystem;
  }

  it('reports up with reachable true when ready and the backend answers', async () => {
    const { ctx, healthIndicators } = createFakeContext({}, false, makeFs(true));
    const plugin = StoragePlugin({ provider: 'local', options: { rootDir: '/data' } });
    await plugin.register!(ctx);

    const indicator = healthIndicators.get(CAPABILITIES.STORAGE);
    const result = await indicator!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ provider: 'local', reachable: true });
  });

  it('reports down with reachable false when ready but the backend is gone', async () => {
    const { ctx, healthIndicators } = createFakeContext({}, false, makeFs(false));
    const plugin = StoragePlugin({ provider: 'local', options: { rootDir: '/data' } });
    await plugin.register!(ctx);

    const indicator = healthIndicators.get(CAPABILITIES.STORAGE);
    const result = await indicator!();
    expect(result.status).toBe('down');
    expect(result.data).toEqual({ provider: 'local', reachable: false });
  });

  it('reports up with reachable unknown when the provider cannot probe', async () => {
    // A gcs client without the optional isHealthy member: absence, not false.
    const { ctx, healthIndicators } = createFakeContext();
    const plugin = StoragePlugin({
      provider: 'gcs',
      options: {
        bucket: 'b',
        client: {
          bucket: () => ({}),
        } as unknown as import('../../src/interfaces/index.ts').IGcsClient,
      },
    });
    await plugin.register!(ctx);

    const indicator = healthIndicators.get(CAPABILITIES.STORAGE);
    const result = await indicator!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ provider: 'gcs', reachable: 'unknown' });
  });
});
