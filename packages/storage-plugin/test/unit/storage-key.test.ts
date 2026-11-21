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
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import { AzureBlobProvider } from '../../src/providers/azure-provider.ts';

const BAD = ['../other/secret.txt', 'a/../../b', './a', 'a/.', '..'];
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
  for (const key of GOOD) {
    it(`accepts ${JSON.stringify(key)}`, () => {
      expect(() => {
        assertStorageKey(key);
      }).not.toThrow();
    });
  }
});

describe('StorageService refuses a traversing key on every operation', () => {
  const ops: readonly (readonly [string, (s: StorageService, k: string) => Promise<unknown>])[] = [
    ['put', (s, k) => s.put(k, new Uint8Array([1]))],
    ['get', (s, k) => s.get(k)],
    ['delete', (s, k) => s.delete(k)],
    ['exists', (s, k) => s.exists(k)],
    ['getSignedUrl', (s, k) => s.getSignedUrl(k, { expiresIn: 60 })],
    ['getStream', (s, k) => s.getStream(k)],
  ];
  for (const [name, run] of ops) {
    it(name, async () => {
      const service = new StorageService(new MemoryProvider(() => 0));
      await expect(run(service, '../x')).rejects.toThrow(/'\.' or '\.\.' segment/);
    });
  }
});

describe('the Azure provider used directly refuses one too', () => {
  it('before any call reaches the client', async () => {
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
    for (const run of [
      () => provider.get('../b/secret.txt'),
      () => provider.getSignedUrl('../b/secret.txt', { expiresIn: 60 }),
      () => provider.put('../b/x', new Uint8Array([1])),
    ]) {
      await expect(run()).rejects.toThrow(/segment/);
    }
    expect(calls).toBe(0);
  });
});
