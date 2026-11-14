import { describe, expect, it } from 'vitest';
import { FORM_FILE_METADATA, formFileMetadataOf, withFormFileMetadata } from '../../src/index.ts';

describe('form-file metadata', () => {
  it('brands in place, hides its keys and shares a global symbol', () => {
    const schema = { marker: 1 };
    const metadata = { mimeTypes: ['image/*'], maxBytes: 12 };
    expect(withFormFileMetadata(schema, metadata)).toBe(schema);
    expect(formFileMetadataOf(schema)).toBe(metadata);
    expect(Object.keys(schema)).toEqual(['marker']);
    expect({ ...schema }).toEqual({ marker: 1 });
    expect(JSON.stringify(schema)).toBe('{"marker":1}');
    expect(Object.getOwnPropertyDescriptor(schema, FORM_FILE_METADATA)).toMatchObject({
      enumerable: false,
      writable: false,
    });
    expect(FORM_FILE_METADATA).toBe(Symbol.for('setu.form-file.metadata'));
    expect(formFileMetadataOf(withFormFileMetadata({}, {}))).toEqual({});
    expect(formFileMetadataOf(withFormFileMetadata({}, { maxBytes: 1 }))).toEqual({ maxBytes: 1 });
    expect(formFileMetadataOf(withFormFileMetadata({}, { mimeTypes: [] }))).toEqual({
      mimeTypes: [],
    });
  });

  it('treats every foreign shape as absent', () => {
    for (const value of [undefined, null, 1, 'file', () => {}, {}, []])
      expect(formFileMetadataOf(value)).toBeUndefined();
    for (const metadata of [
      null,
      'file',
      1,
      { mimeTypes: 'image/*' },
      { mimeTypes: [1] },
      { mimeTypes: undefined },
      { maxBytes: undefined },
      { maxBytes: '1' },
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: 1.2 },
      { maxBytes: NaN },
      { maxBytes: Infinity },
      { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(formFileMetadataOf({ [FORM_FILE_METADATA]: metadata })).toBeUndefined();
    }
  });
});
