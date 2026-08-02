/**
 * `R2Storage` against a fake bucket whose `delete` returns void and reports
 * nothing, exactly as the real binding does — which is the reason the store
 * heads first.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  CloudflareObjectNotFoundError,
  CloudflareUnsupportedError,
  R2Storage,
} from '../../../src/index.ts';
import { FakeR2, readAll } from '../../fakes.ts';

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('R2Storage', () => {
  it('writes and reads bytes back', async () => {
    const bucket = new FakeR2();
    const storage = new R2Storage(bucket);

    await storage.put('a.bin', BYTES);
    expect(await storage.get('a.bin')).toEqual(BYTES);
  });

  it('throws a named error for a missing object rather than returning null', async () => {
    const storage = new R2Storage(new FakeR2());
    // IStorage.get is contracted as Promise<Uint8Array> with no null arm.
    await expect(storage.get('missing.bin')).rejects.toBeInstanceOf(CloudflareObjectNotFoundError);
  });

  it('streams an object without buffering it', async () => {
    const bucket = new FakeR2();
    const storage = new R2Storage(bucket);
    await storage.put('a.bin', BYTES);

    const stream = await storage.getStream('a.bin');
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(await readAll(stream)).toEqual(BYTES);
  });

  it('throws from getStream for a missing object', async () => {
    const storage = new R2Storage(new FakeR2());
    await expect(storage.getStream('missing.bin')).rejects.toBeInstanceOf(
      CloudflareObjectNotFoundError,
    );
  });

  it('reports existence', async () => {
    const storage = new R2Storage(new FakeR2());
    expect(await storage.exists('a.bin')).toBe(false);
    await storage.put('a.bin', BYTES);
    expect(await storage.exists('a.bin')).toBe(true);
  });

  it('reports from delete() whether the object existed, heading first', async () => {
    const bucket = new FakeR2();
    const storage = new R2Storage(bucket);
    await storage.put('a.bin', BYTES);

    expect(await storage.delete('a.bin')).toBe(true);
    // R2's own delete resolves for an absent key and says nothing, so a second
    // call must come back false from the head, not from the delete.
    expect(await storage.delete('a.bin')).toBe(false);
    expect(bucket.deletes).toEqual(['a.bin', 'a.bin']);
  });

  it('applies the configured prefix on every path', async () => {
    const bucket = new FakeR2();
    const storage = new R2Storage(bucket, { prefix: 'uploads/' });

    await storage.put('a.bin', BYTES);
    expect([...bucket.objects.keys()]).toEqual(['uploads/a.bin']);

    expect(await storage.get('a.bin')).toEqual(BYTES);
    expect(await storage.exists('a.bin')).toBe(true);
    expect(await readAll(await storage.getStream('a.bin'))).toEqual(BYTES);
    expect(await storage.delete('a.bin')).toBe(true);
    expect(bucket.deletes).toEqual(['uploads/a.bin']);
  });

  it('refuses to presign, because the R2 binding has no such operation', async () => {
    const storage = new R2Storage(new FakeR2());

    await expect(storage.getSignedUrl('a.bin', { expiresIn: 600 })).rejects.toBeInstanceOf(
      CloudflareUnsupportedError,
    );
    // The message must point at the alternatives, not just refuse.
    await storage.getSignedUrl('a.bin', { expiresIn: 600 }).catch((error: unknown) => {
      expect(String(error)).toContain('getStream');
      expect(String(error)).toContain('custom domain');
    });
  });
});
