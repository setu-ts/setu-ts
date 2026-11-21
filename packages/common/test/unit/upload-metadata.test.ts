import { describe, expect, it } from 'vitest';
import { UPLOAD_METADATA, uploadMetadataOf, withUploadMetadata } from '../../src/index.ts';

describe('upload metadata', () => {
  it('brands a middleware in place, hidden, under a global symbol', () => {
    const middleware = (): Promise<void> => Promise.resolve();
    const metadata = { fieldname: 'file', maxBytes: 1024, maxFiles: 2, mimeTypes: ['image/png'] };
    expect(withUploadMetadata(middleware, metadata)).toBe(middleware);
    expect(uploadMetadataOf(middleware)).toBe(metadata);
    expect(Object.keys(middleware)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(middleware, UPLOAD_METADATA)).toMatchObject({
      enumerable: false,
      writable: false,
    });
    expect(UPLOAD_METADATA).toBe(Symbol.for('setu.upload.metadata'));
    const minimal = { fieldname: 'doc', maxBytes: 1 };
    expect(uploadMetadataOf(withUploadMetadata(() => undefined, minimal))).toBe(minimal);
  });

  it('treats every foreign shape as absent', () => {
    for (const value of [undefined, null, 1, 'x', {}, () => undefined])
      expect(uploadMetadataOf(value)).toBeUndefined();
    for (const metadata of [
      null,
      'x',
      {},
      { fieldname: '', maxBytes: 1 },
      { fieldname: 1, maxBytes: 1 },
      { fieldname: 'f' },
      { fieldname: 'f', maxBytes: 0 },
      { fieldname: 'f', maxBytes: 1.5 },
      { fieldname: 'f', maxBytes: '1' },
      { fieldname: 'f', maxBytes: 1, maxFiles: 0 },
      { fieldname: 'f', maxBytes: 1, maxFiles: 'two' },
      { fieldname: 'f', maxBytes: 1, mimeTypes: 'image/png' },
      { fieldname: 'f', maxBytes: 1, mimeTypes: [1] },
    ]) {
      const carrier = (): undefined => undefined;
      Object.defineProperty(carrier, UPLOAD_METADATA, { value: metadata });
      expect(uploadMetadataOf(carrier)).toBeUndefined();
    }
  });
});
