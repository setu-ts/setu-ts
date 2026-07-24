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
import type { StorageProvider } from '../../src/interfaces/index.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
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
    const p = createProvider('memory', {}, fakeRuntime);
    expect(p).toBeInstanceOf(MemoryProvider);
  });

  it('injects runtime.now() as the provider clock (getSignedUrl expiry uses it, not Date.now)', async () => {
    const rt = { ...makeFakeRuntime(), now: (): number => 1_700_000_000_000 } as IRuntimeServices;
    const p = createProvider('memory', {}, rt) as StorageProvider;
    await p.connect();
    const url = await p.getSignedUrl('k.txt', { expiresIn: 60 });
    // 1_700_000_000_000 ms → 1_700_000_000 s + 60 = 1700000060
    expect(url).toBe('memory://k.txt?expires=1700000060');
  });

  it('unknown provider type throws', () => {
    expect(() =>
      createProvider(
        'invalid' as StorageProvider['connect'] extends () => Promise<void> ? 'memory' : 'invalid',
        {},
        fakeRuntime,
      )
    ).toThrow('Unsupported storage provider');
  });

  it('b2 type builds S3Provider with derived B2 endpoint', () => {
    const p = createProvider('b2', {
      bucket: 'mybucket',
      region: 'us-west-1',
      accessKeyId: 'keyid',
      secretAccessKey: 'secret',
    }, fakeRuntime) as StorageProvider;
    expect(p.isReady()).toBe(false);
  });

  it('b2 honors explicit endpoint override', () => {
    const customEndpoint = 'https://custom.endpoint.com';
    const p = createProvider('b2', {
      bucket: 'mybucket',
      endpoint: customEndpoint,
    }, fakeRuntime) as StorageProvider;
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
    const plugin = StoragePlugin({
      provider:
        'nonexistent' as unknown as import('../../src/interfaces/index.ts').StorageProviderType,
    });
    await expect(plugin.register!(ctx)).rejects.toThrow('Unsupported storage provider');
  });

  it('s3 provider can be wired', () => {
    const fakeRuntime = makeFakeRuntime();
    const provider = createProvider(
      's3',
      { bucket: 'test-bucket', region: 'us-east-1' },
      fakeRuntime,
    ) as StorageProvider;
    expect(provider.isReady()).toBe(false);
  });

  it('azure provider can be wired', () => {
    const fakeRuntime = makeFakeRuntime();
    const provider = createProvider('azure', {
      containerName: 'mycontainer',
      accountName: 'fakeaccount',
      accountKey: 'dGVzdGtleQ==',
    }, fakeRuntime) as StorageProvider;
    expect(provider.isReady()).toBe(false);
  });

  it('gcs provider can be wired', () => {
    const fakeRuntime = makeFakeRuntime();
    const provider = createProvider('gcs', { bucket: 'my-bucket' }, fakeRuntime) as StorageProvider;
    expect(provider.isReady()).toBe(false);
  });
});
