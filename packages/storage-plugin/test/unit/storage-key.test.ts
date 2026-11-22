/**
 * A key with a `.` or `..` segment is refused on every provider and every
 * operation (security audit F1/F2: on Azure such a key reached, and signed a
 * URL for, a blob in another container).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { assertStorageKey } from '../../src/services/storage-key.ts';
import { StorageService } from '../../src/services/storage-service.ts';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';
import { PROVIDERS } from '../fixtures/provider-fakes.ts';

const BAD = ['../other/secret.txt', 'a/../../b', './a', 'a/.', '..'];
// A boxed String is the case under test: an SDK reads it as its value.
const NON_STRING: readonly unknown[] = [new String('../other/secret.txt'), undefined, 7, ['..']];
// A key naming no object: the bucket itself (on S3, a listing) or the local root.
const NO_OBJECT: readonly string[] = ['', '/', '//', '///'];
const GOOD = ['a.txt', 'docs/a b/ñ#1?.txt', '.hidden', 'a..b', '/leading', 'a//b'];

describe('assertStorageKey', () => {
  for (const key of BAD) {
    it(`refuses ${JSON.stringify(key)} with a 400 that does not quote the key`, () => {
      let thrown: unknown;
      try {
        assertStorageKey(key);
      } catch (error) {
        thrown = error;
      }
      expect(httpStatusHintOf(thrown)).toEqual({
        status: 400,
        title: 'Bad Request',
        detail: "A storage key may not contain a '.' or '..' path segment.",
      });
    });
  }
  for (const key of NO_OBJECT) {
    it(`refuses ${JSON.stringify(key)} with its own 400`, () => {
      let thrown: unknown;
      try {
        assertStorageKey(key);
      } catch (error) {
        thrown = error;
      }
      expect(httpStatusHintOf(thrown)).toEqual({
        status: 400,
        title: 'Bad Request',
        detail: "A storage key may not be empty or only '/'.",
      });
    });
  }
  for (const key of GOOD) {
    it(`accepts ${JSON.stringify(key)}`, () => {
      expect(() => {
        assertStorageKey(key);
      }).not.toThrow();
    });
  }
});

type Op = readonly [string, (s: StorageProvider | StorageService, k: string) => Promise<unknown>];

const OPS: readonly Op[] = [
  ['put', (s, k) => s.put(k, new Uint8Array([1]))],
  ['get', (s, k) => s.get(k)],
  ['delete', (s, k) => s.delete(k)],
  ['exists', (s, k) => s.exists(k)],
  ['getSignedUrl', (s, k) => s.getSignedUrl(k, { expiresIn: 60 })],
  // Optional on StorageProvider; every provider under test implements it.
  ['getStream', (s, k) => s.getStream?.(k) ?? Promise.reject(new Error('no getStream'))],
];

/** Wraps a provider so every call after connect() is counted. */
function counted(provider: StorageProvider): { provider: StorageProvider; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(provider, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      // Called on the target, so a provider's private fields resolve.
      return (...args: unknown[]) => {
        if (prop !== 'connect') calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { provider: proxy, calls };
}

describe('every provider, through StorageService, refuses a traversing key on every operation', () => {
  for (const [name, factory] of PROVIDERS) {
    for (const [op, run] of OPS) {
      it(`${name}: ${op} answers 400 and the provider is never called`, async () => {
        const { provider, calls } = counted(factory());
        await provider.connect();
        const service = new StorageService(provider);
        for (const key of [...BAD, ...NO_OBJECT, ...NON_STRING]) {
          const error = await run(service, key as string).catch((e: unknown) => e);
          expect(httpStatusHintOf(error)?.status).toBe(400);
        }
        expect(calls).toEqual([]);
      });
    }
    // Negative control: the same wiring passes an ordinary key to the backend.
    it(`${name}: an ordinary key reaches the provider and reads back`, async () => {
      const { provider, calls } = counted(factory());
      await provider.connect();
      const service = new StorageService(provider);
      await service.put('dir/a..b.txt', new Uint8Array([1]));
      expect(await service.exists('dir/a..b.txt')).toBe(true);
      expect(calls).toEqual(['put', 'exists']);
    });
  }
});

const DIRECT = PROVIDERS.filter(
  ([name]) => name === 's3 / b2' || name === 'gcs' || name === 'azure',
);

describe('the cloud providers used directly refuse one too', () => {
  for (const [name, factory] of DIRECT) {
    it(`${name}: every operation answers 400`, async () => {
      const provider = factory();
      await provider.connect();
      for (const [, run] of OPS) {
        for (const key of BAD) {
          const error = await run(provider, key).catch((e: unknown) => e);
          expect(httpStatusHintOf(error)?.status).toBe(400);
        }
      }
    });

    it(`${name}: a key naming no object, or a non-string key (a boxed String included) rejects with a 400`, async () => {
      const provider = factory();
      await provider.connect();
      for (const [, run] of OPS) {
        for (const key of [...NO_OBJECT, ...NON_STRING]) {
          let pending: Promise<unknown> | undefined;
          expect(() => {
            pending = run(provider, key as string);
          }).not.toThrow();
          const error = await pending?.catch((e: unknown) => e);
          expect(httpStatusHintOf(error)?.status).toBe(400);
        }
      }
    });
  }

  it('azure: no call reaches the client', async () => {
    let calls = 0;
    const provider = new AzureBlobProvider(
      {
        containerName: 'c',
        client: {
          getContainerClient: () => {
            calls++;
            return { getBlockBlobClient: () => ({}) };
          },
        },
      },
      () => 0,
    );
    await provider.connect();
    for (const [, run] of OPS) {
      for (const key of BAD) {
        const error = await run(provider, key).catch((e: unknown) => e);
        expect(httpStatusHintOf(error)?.status).toBe(400);
      }
    }
    expect(calls).toBe(0);
  });
});
