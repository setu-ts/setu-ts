/**
 * The plugin's arm wiring: `b2` needs a region or an endpoint (V13-248), each
 * cloud arm receives its new options, the storage probe is cached and bounded
 * (V13-215), and a missing object is a named 404 (V13-217).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IRuntimeServices, IStorage } from '@setu-ts/common';
import { CAPABILITIES, httpStatusHintOf, StorageObjectNotFoundError } from '@setu-ts/common';
import { createProvider, StoragePlugin } from '../../src/plugin/storage-plugin.ts';
import { S3Provider } from '../../src/providers/s3-provider.ts';
import { GcsProvider } from '../../src/providers/gcs-provider.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import { StorageService } from '../../src/services/storage-service.ts';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

function runtime(): IRuntimeServices {
  return {
    env: {},
    now: () => 1_700_000_000_000,
    hrtime: () => performance.now(),
    platform: () => 'node',
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  } as unknown as IRuntimeServices;
}

describe('the b2 arm (V13-248)', () => {
  it('refuses a configuration with neither region nor endpoint, naming both', () => {
    expect(() =>
      createProvider({ provider: 'b2', options: { bucket: 'b', accessKeyId: 'k' } }, runtime()),
    ).toThrow(/'b2' provider needs options\.region .* or options\.endpoint/);
  });

  it('accepts a region, an endpoint, or an injected client', () => {
    for (const options of [
      { bucket: 'b', region: 'us-west-004' },
      { bucket: 'b', endpoint: 'http://127.0.0.1:9000' },
      {
        bucket: 'b',
        client: {
          put: () => Promise.resolve(),
          get: () => Promise.resolve(null),
          delete: () => Promise.resolve(true),
          head: () => Promise.resolve(false),
          getSignedUrl: () => Promise.resolve(''),
          getStream: () => Promise.resolve(null),
        },
      },
    ]) {
      expect(createProvider({ provider: 'b2', options }, runtime())).toBeInstanceOf(S3Provider);
    }
  });

  it('names itself b2 in a fault and honours requestTimeoutMs', async () => {
    const provider = createProvider(
      {
        provider: 'b2',
        options: {
          bucket: 'b',
          region: 'us-west-004',
          requestTimeoutMs: 20,
          client: {
            put: () => Promise.resolve(),
            get: () => new Promise<null>(() => undefined),
            delete: () => Promise.resolve(true),
            head: () => Promise.resolve(false),
            getSignedUrl: () => Promise.resolve(''),
            getStream: () => Promise.resolve(null),
          },
        },
      },
      runtime(),
    );
    await provider.connect();
    await expect(provider.get('k')).rejects.toThrow('storage-plugin (b2): get');
  });
});

describe('each cloud arm receives its new options', () => {
  it('gcs takes endpoint, endpointAuth and requestTimeoutMs; azure takes endpoint and requestTimeoutMs', () => {
    expect(
      createProvider(
        {
          provider: 'gcs',
          options: { bucket: 'b', endpoint: 'http://e', endpointAuth: false, requestTimeoutMs: 1 },
        },
        runtime(),
      ),
    ).toBeInstanceOf(GcsProvider);
    expect(
      createProvider(
        {
          provider: 'azure',
          options: { containerName: 'c', endpoint: 'http://e', requestTimeoutMs: 1 },
        },
        runtime(),
      ),
    ).toBeInstanceOf(AzureBlobProvider);
    expect(() =>
      createProvider({ provider: 's3', options: { bucket: 'b', requestTimeoutMs: -5 } }, runtime()),
    ).toThrow(RangeError);
  });
});

describe('the storage readiness probe is cached and bounded (V13-215)', () => {
  it('a probe that never answers is down within the 2 s bound, and is not re-run inside the TTL', async () => {
    let calls = 0;
    const provider: StorageProvider = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      isHealthy: () => {
        calls++;
        return new Promise<boolean>(() => undefined);
      },
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(true),
      exists: () => Promise.resolve(false),
      getSignedUrl: () => Promise.resolve(''),
    };
    const { ctx, healthIndicators } = createFakeContext();
    const plugin = StoragePlugin({
      provider: 's3',
      options: {
        bucket: 'b',
        client: {
          put: () => Promise.resolve(),
          get: () => Promise.resolve(null),
          delete: () => Promise.resolve(true),
          head: () => Promise.resolve(true),
          getSignedUrl: () => Promise.resolve(''),
          getStream: () => Promise.resolve(null),
        },
      },
    });
    // Swap the provider's probe for one that never answers, through the
    // prototype the plugin calls.
    const original = S3Provider.prototype.isHealthy;
    S3Provider.prototype.isHealthy = provider.isHealthy as () => Promise<boolean>;
    try {
      await plugin.register(ctx);
      const indicator = healthIndicators.get(CAPABILITIES.STORAGE)!;
      const started = performance.now();
      const first = await indicator();
      expect(performance.now() - started).toBeLessThan(4000);
      expect(first).toEqual({ status: 'down', data: { provider: 's3', reachable: false } });
      await indicator();
      expect(calls).toBe(1);
    } finally {
      S3Provider.prototype.isHealthy = original;
    }
  }, 10_000);
});

describe('a missing object is a named 404 (V13-217)', () => {
  it('get and getStream throw StorageObjectNotFoundError with a fixed detail', async () => {
    const provider: StorageProvider = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(false),
      exists: () => Promise.resolve(false),
      getSignedUrl: () => Promise.resolve(''),
      getStream: () => Promise.resolve(null),
    };
    const service: IStorage = new StorageService(provider);
    for (const run of [() => service.get('docs/a.pdf'), () => service.getStream!('docs/a.pdf')]) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageObjectNotFoundError);
      expect((error as StorageObjectNotFoundError).key).toBe('docs/a.pdf');
      expect(httpStatusHintOf(error)).toMatchObject({
        status: 404,
        detail: 'The requested object was not found.',
      });
    }
  });
});
