import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { withFormFileMetadata } from '@setu-ts/common';
import { fileMetadataOf, formFileFieldsOf } from '../../src/generators/form-fields.ts';

const file = () => withFormFileMetadata(z.custom<unknown>(), { mimeTypes: ['image/*'] });

describe('form field structural walk', () => {
  it('reads own brands and metadata clone parents but does not unwrap wrappers in fileMetadataOf', () => {
    const schema = file();
    for (const node of [
      schema,
      schema.describe('image'),
      schema.meta({ title: 'image' }).describe('image'),
    ])
      expect(fileMetadataOf(node)).toEqual({ mimeTypes: ['image/*'] });
    expect(fileMetadataOf(schema.optional())).toBeUndefined();
    for (const node of [undefined, null, false, {}, { _zod: null }, { _zod: { parent: 1 } }])
      expect(fileMetadataOf(node)).toBeUndefined();
    const cycle: { _zod: { parent?: unknown } } = { _zod: {} };
    cycle._zod.parent = cycle;
    expect(fileMetadataOf(cycle)).toBeUndefined();
    expect(formFileFieldsOf(cycle).size).toBe(0);
  });
  it('unwraps every root and field wrapper, arrays and metadata clones', () => {
    const field = file();
    const object = z.object({
      file: field,
      names: z.array(z.string()),
      nested: z.object({ file: field }),
    });
    const roots = [
      object,
      object.describe('body'),
      object.optional(),
      object.nullable(),
      object.default({ file: '', names: [], nested: { file: '' } }),
      object.readonly(),
      object.catch({ file: '', names: [], nested: { file: '' } }),
      object.pipe(z.custom<z.output<typeof object>>()),
    ];
    for (const root of roots) expect([...formFileFieldsOf(root).keys()]).toEqual(['file']);
    const fields = [
      field,
      field.describe('file'),
      field.optional(),
      field.nullable(),
      field.default(''),
      field.readonly(),
      field.catch(''),
      field.pipe(z.unknown()),
      z.array(field),
      z.array(field.optional()).optional(),
    ];
    for (const value of fields)
      expect([...formFileFieldsOf(z.object({ upload: value }))]).toEqual([
        ['upload', { mimeTypes: ['image/*'] }],
      ]);
  });
  it('returns no fields for non-Zod, non-object and malformed inputs', () => {
    for (const input of [
      undefined,
      null,
      1,
      {},
      z.string(),
      z.array(file()),
      { _zod: { def: { type: 'object' } } },
      { _zod: { def: { type: 'optional' } } },
    ])
      expect(formFileFieldsOf(input).size).toBe(0);
  });
});
