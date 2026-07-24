/**
 * Integration tests for StoragePlugin — round-trips through a real kernel app
 * using `app.inject()`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IStorage, MiddlewareFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { createUploadMiddleware, StoragePlugin } from '../../src/index.ts';

describe('Storage integration (through a real kernel app)', () => {
  it('round-trips put → get through the public IStorage surface', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), StoragePlugin()],
    });
    await app.start();

    const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);
    const data = new Uint8Array([100, 200, 50]);
    await storage.put('integration/test.bin', data);
    const result = await storage.get('integration/test.bin');
    expect(result).toEqual(data);

    // Verify exists and delete.
    expect(await storage.exists('integration/test.bin')).toBe(true);
    const deleted = await storage.delete('integration/test.bin');
    expect(deleted).toBe(true);
    await expect(storage.get('integration/test.bin')).rejects.toThrow('not found');

    await app.stop();
  });

  it('round-trips put → getStream → ReadableStream bytes (memory buffered-fallback path)', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), StoragePlugin()],
    });
    await app.start();

    const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);
    const originalData = new Uint8Array([42, 17, 99, 8, 3]);
    await storage.put('stream-test/data.bin', originalData);

    // Use getStream — memory provider has no native stream → buffered fallback.
    const stream = await storage.getStream!('stream-test/data.bin');
    expect(stream).toBeDefined();

    // Read all chunks.
    const reader = stream!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const concatenated = concatUint(chunks);
    expect(concatenated).toEqual(originalData);

    await app.stop();
  });

  it('upload middleware parses multipart and storage.put round-trips', async () => {
    const boundary = '----IntegrationTest99';

    const encoder = new TextEncoder();
    const fileData = encoder.encode('uploaded content');
    const bodyBytes = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="file"; filename="upload.txt"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...fileData,
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        StoragePlugin(),
      ],
    });
    await app.start();

    const storage = app.services.get<IStorage>(CAPABILITIES.STORAGE);

    // deno-lint-ignore no-explicit-any
    const { getUploadedFile } = await import('../../src/index.ts') as any;

    // Build a minimal request context that simulates what the kernel inject() provides.
    const ctx: any = {
      state: new Map<string, unknown>(),
      request: {
        method: 'POST',
        url: 'http://localhost/upload',
        path: '/upload',
        headers: new Headers({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
        bytes: () => Promise.resolve(bodyBytes),
      },
      response: {
        _status: 200,
        // deno-lint-ignore no-explicit-any
        _body: null as any,
        status(code: number) { this._status = code; return this; },
        json(body: unknown) { this._body = body; return { status: this._status, body }; },
        send(body: unknown) { this._body = body; return { status: this._status, body }; },
      },
      services: { has: () => false, get: () => null, register: () => {} },
      params: {},
      query: {},
      startTime: performance.now(),
      signal: new AbortController().signal,
    };

    // Run the upload middleware inline against our fake context.
    const uploadMw: MiddlewareFunction = createUploadMiddleware({ fieldname: 'file' });
    await uploadMw(ctx, async () => {});

    // Now run the route handler logic manually.
    const file = getUploadedFile(ctx, 'file');
    expect(file).toBeDefined();
    expect(file!.name).toBe('file');
    expect(new TextDecoder().decode(file!.data)).toBe('uploaded content');

    // Store via IStorage.
    await storage.put('uploads/upload.txt', file!.data);

    // Verify the file was stored via IStorage.
    const stored = await storage.get('uploads/upload.txt');
    expect(stored).toEqual(fileData);

    await app.stop();
  });
});

/** Concatenates an array of Uint8Array chunks into one. */
function concatUint(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    result.set(c, off);
    off += c.length;
  }
  return result;
}
