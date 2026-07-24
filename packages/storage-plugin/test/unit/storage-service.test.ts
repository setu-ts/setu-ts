/**
 * Tests for {@linkcode StorageService} — absent→throw, stream delegation, fallback.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { StorageProvider } from '../../src/interfaces/index.ts';
import { StorageService } from '../../src/services/storage-service.ts';

/** Creates a minimal fake provider for testing. */
function createFakeProvider(partial?: Partial<StorageProvider>): StorageProvider {
  return {
    connect(): Promise<void> { return Promise.resolve(); },
    disconnect(): Promise<void> { return Promise.resolve(); },
    isReady(): boolean { return true; },
    put(_path: string, _data: Uint8Array): Promise<void> { return Promise.resolve(); },
    get(_path: string): Promise<Uint8Array | null> { return Promise.resolve(new Uint8Array()); },
    delete(_path: string): Promise<boolean> { return Promise.resolve(true); },
    exists(_path: string): Promise<boolean> { return Promise.resolve(true); },
    getSignedUrl(_path: string, _options: { expiresIn: number }): Promise<string> { return Promise.resolve('https://example.com'); },
    ...partial,
  };
}

describe('StorageService', () => {
  describe('get', () => {
    it('delegates to provider.get when present', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const provider = createFakeProvider({ get: () => Promise.resolve(data) });
      const service = new StorageService(provider);
      const result = await service.get('key');
      expect(result).toEqual(data);
    });

    it('throws when provider.get returns null', async () => {
      const provider = createFakeProvider({ get: () => Promise.resolve(null) });
      const service = new StorageService(provider);
      await expect(service.get('missing')).rejects.toThrow('Storage object not found: missing');
    });
  });

  describe('put / delete / exists', () => {
    it('delegates put to provider', async () => {
      let called = false;
      const provider = createFakeProvider({
        put(_path: string, _data: Uint8Array): Promise<void> {
          called = true;
          return Promise.resolve();
        },
      });
      const service = new StorageService(provider);
      await service.put('path', new Uint8Array([1]));
      expect(called).toBe(true);
    });

    it('delegates delete to provider', async () => {
      const provider = createFakeProvider({ delete: () => Promise.resolve(true) });
      const service = new StorageService(provider);
      const result = await service.delete('path');
      expect(result).toBe(true);
    });

    it('delegates exists to provider', async () => {
      const provider = createFakeProvider({ exists: () => Promise.resolve(false) });
      const service = new StorageService(provider);
      const result = await service.exists('path');
      expect(result).toBe(false);
    });
  });

  describe('getSignedUrl', () => {
    it('passes expiresIn through to provider', async () => {
      let receivedExpiresIn = 0;
      const provider = createFakeProvider({
        getSignedUrl(_path: string, options: { expiresIn: number }): Promise<string> {
          receivedExpiresIn = options.expiresIn;
          return Promise.resolve('https://signed.url');
        },
      });
      const service = new StorageService(provider);
      await service.getSignedUrl('path', { expiresIn: 3600 });
      expect(receivedExpiresIn).toBe(3600);
    });
  });

  describe('getStream', () => {
    it('delegates to provider.getStream when available', async () => {
      const expectedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([42]));
          controller.close();
        },
      });
      const provider = createFakeProvider({
        getStream(): Promise<ReadableStream<Uint8Array> | null> { return Promise.resolve(expectedStream); },
      });
      const service = new StorageService(provider);
      const result = await service.getStream('key');
      // Verify it's a ReadableStream.
      expect(result).toBeDefined();
      // Read the stream chunks.
      const reader = result!.getReader();
      const chunk1 = await reader.read();
      expect(chunk1.done).toBe(false);
      expect(chunk1.value).toEqual(new Uint8Array([42]));
      const chunk2 = await reader.read();
      expect(chunk2.done).toBe(true);
    });

    it('throws when provider.getStream returns null', async () => {
      const provider = createFakeProvider({
        getStream(): Promise<null> { return Promise.resolve(null); },
      });
      const service = new StorageService(provider);
      await expect(service.getStream('missing')).rejects.toThrow(
        'Storage object not found: missing',
      );
    });

    it('falls back to buffered get when provider has no getStream', async () => {
      const data = new Uint8Array([10, 20, 30]);
      // Provider without getStream method.
      const provider = createFakeProvider({
        get(path: string): Promise<Uint8Array | null> {
          return Promise.resolve(path === 'key' ? data : null);
        },
        // No getStream property.
        getStream: undefined as unknown as StorageProvider['getStream'],
      } as Partial<StorageProvider> as StorageProvider);
      const service = new StorageService(provider);
      const result = await service.getStream('key');
      expect(result).toBeDefined();
      const reader = result!.getReader();
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(data);
      const next = await reader.read();
      expect(next.done).toBe(true);
    });

    it('fallback throws when get returns null (absent)', async () => {
      const provider = createFakeProvider({
        get(): Promise<null> { return Promise.resolve(null); },
        getStream: undefined as unknown as StorageProvider['getStream'],
      } as Partial<StorageProvider> as StorageProvider);
      const service = new StorageService(provider);
      await expect(service.getStream('missing')).rejects.toThrow(
        'Storage object not found: missing',
      );
    });
  });
});
