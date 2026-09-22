/**
 * The ten cloud-provider methods that guard with `#assertConnected()` must
 * REJECT when the provider is disconnected — never throw synchronously —
 * because every one of them is typed `Promise<...>`: a synchronous throw
 * escapes before the promise is returned, so a caller using `.catch()`
 * never sees it and the error is uncaught.
 *
 * The table is the set, as data, not prose: one row per fixed method. The
 * discriminating assertion is the two-step form — `await
 * expect(promise).rejects` alone would pass against a synchronous throw
 * too, because `await` on the expression catches it either way; the
 * `threwSync` flag is what proves the throw no longer escapes.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import { GcsProvider } from '../../src/providers/gcs-provider.ts';
import { S3Provider } from '../../src/providers/s3-provider.ts';

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
