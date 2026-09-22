/**
 * The ten cloud-provider methods that guard with `#assertConnected()` must
 * REJECT when the provider is disconnected — never throw synchronously —
 * because every one of them is typed `Promise<...>`: a synchronous throw
 * escapes before the promise is returned, so a caller using `.catch()`
 * never sees it and the error is uncaught.
 *
 * The table is the set, as data, not prose: one row per fixed method.
 *
 * The `threwSync` flag is a LEGIBILITY device, not the thing that makes the
 * test discriminate — probed, and a bare `await expect(invoke()).rejects`
 * DOES fail against a synchronous throw, because the argument is evaluated
 * before `expect` is called, so the throw escapes the test body. What it
 * escapes as is an uncaught error with a stack rather than an assertion
 * failure, which names the wrong thing. Capturing it turns that into
 * `expect(threwSync).toBe(false)`, so the report says what actually broke.
 *
 * The second block guards the same property one level up, on the PUBLISHED
 * `IStorage` contract. It exists because `StorageService.getSignedUrl` is a
 * bare `return this.#provider.getSignedUrl(...)` passthrough, so a provider
 * throwing synchronously escapes straight out of the capability an
 * application resolves from `CAPABILITIES.STORAGE` — which is how the
 * `local` provider's refusal reached callers. Every provider is driven, so
 * the set cannot silently lose a member.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import { GcsProvider } from '../../src/providers/gcs-provider.ts';
import { S3Provider } from '../../src/providers/s3-provider.ts';
import { LocalStorageProvider } from '../../src/providers/local-provider.ts';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import { StorageService } from '../../src/services/storage-service.ts';
import type { StorageProvider } from '../../src/interfaces/index.ts';

interface Case {
  /** The provider method under test, as `<Class>.<method>`. */
  readonly name: string;
  /** Drives the DISCONNECTED provider (no `connect()` call). */
  readonly invoke: () => Promise<unknown>;
}

const cases: readonly Case[] = [
  { name: 'S3Provider.get', invoke: () => new S3Provider({ bucket: 'b' }).get('k') },
  { name: 'S3Provider.delete', invoke: () => new S3Provider({ bucket: 'b' }).delete('k') },
  { name: 'S3Provider.exists', invoke: () => new S3Provider({ bucket: 'b' }).exists('k') },
  {
    name: 'S3Provider.getSignedUrl',
    invoke: () => new S3Provider({ bucket: 'b' }).getSignedUrl('k', { expiresIn: 60 }),
  },
  { name: 'S3Provider.getStream', invoke: () => new S3Provider({ bucket: 'b' }).getStream('k') },
  {
    name: 'GcsProvider.put',
    invoke: () => new GcsProvider({ bucket: 'b' }).put('k', new Uint8Array()),
  },
  { name: 'GcsProvider.getStream', invoke: () => new GcsProvider({ bucket: 'b' }).getStream('k') },
  {
    name: 'AzureBlobProvider.delete',
    invoke: () => new AzureBlobProvider({ containerName: 'c' }).delete('k'),
  },
  {
    name: 'AzureBlobProvider.exists',
    invoke: () => new AzureBlobProvider({ containerName: 'c' }).exists('k'),
  },
  {
    name: 'AzureBlobProvider.getSignedUrl',
    invoke: () =>
      new AzureBlobProvider({ containerName: 'c' }).getSignedUrl('k', { expiresIn: 60 }),
  },
];

describe('disconnected cloud providers reject, never throw synchronously', () => {
  for (const c of cases) {
    it(`${c.name} rejects (no synchronous throw)`, async () => {
      let threwSync = false;
      let promise: Promise<unknown> | undefined;
      try {
        promise = c.invoke();
      } catch {
        threwSync = true;
      }
      expect(threwSync).toBe(false);
      await expect(promise).rejects.toThrow(/not connected/i);
    });
  }
});

/**
 * Every `IStorage.getSignedUrl` answers through a promise — a provider that
 * CAN presign, one that cannot, and one that fabricates a synthetic URL.
 * `local` is the row that regressed: its refusal is permanent rather than a
 * lifecycle precondition, which is why it was missed when the ten
 * `#assertConnected` methods were fixed.
 */
describe('IStorage.getSignedUrl never throws synchronously', () => {
  const providers: readonly (readonly [string, () => StorageProvider])[] = [
    // `undefined` is the constructor's own declared first argument, not a
    // stand-in: this refusal is reached before any filesystem access, so a
    // fake would only add a double cast and a contract to get wrong.
    [
      'local (refuses — cannot presign)',
      () => new LocalStorageProvider(undefined, { rootDir: '/root' }),
    ],
    ['memory (resolves a synthetic URL)', () => new MemoryProvider()],
    ['s3 (disconnected)', () => new S3Provider({ bucket: 'b' })],
    ['gcs (disconnected)', () => new GcsProvider({ bucket: 'b' })],
    ['azure (disconnected)', () => new AzureBlobProvider({ containerName: 'c' })],
  ];

  for (const [name, make] of providers) {
    it(`${name} settles rather than throwing`, async () => {
      const storage = new StorageService(make());
      let threwSync = false;
      let promise: Promise<string> | undefined;
      try {
        promise = storage.getSignedUrl('k', { expiresIn: 60 });
      } catch {
        threwSync = true;
      }
      expect(threwSync).toBe(false);
      // Settled either way — the point is that it is a promise outcome, not
      // an escaped throw. `catch` swallows the refusals; the flag is the test.
      await promise?.catch(() => undefined);
    });
  }
});
