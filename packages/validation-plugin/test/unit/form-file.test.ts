import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FormFile } from '@setu-ts/common';
import { formFileMetadataOf } from '@setu-ts/common';
import { formFile } from '../../src/zod/index.ts';

const file = (mimeType = 'text/plain', size = 3): FormFile => ({
  filename: 'hello.txt',
  mimeType,
  data: new Uint8Array(size),
});

describe('formFile', () => {
  it('has FormFile input and output and works in an object', () => {
    const schema: z.ZodCustom<FormFile, FormFile> = formFile();
    const value = file();
    expect(z.object({ file: schema }).parse({ file: value })).toEqual({ file: value });
    expect(formFileMetadataOf(schema)).toEqual({});
    expect(schema.parse(file('anything'))).toEqual(file('anything'));
  });
  it('normalizes MIME options, matches exact and wildcard essences, and retains the final brand', () => {
    const schema = formFile({ mimeTypes: ['IMAGE/*', 'Text/Plain'], maxBytes: 3 });
    expect(formFileMetadataOf(schema)).toEqual({
      mimeTypes: ['image/*', 'text/plain'],
      maxBytes: 3,
    });
    for (const type of ['image/png', ' IMAGE/JPEG ; charset=utf-8', 'TEXT/PLAIN; charset=utf-8'])
      expect(schema.safeParse(file(type)).success).toBe(true);
    expect(
      schema.safeParse(file('application/json')).error?.issues.map((issue) => issue.message),
    ).toEqual(['File type application/json is not accepted']);
    expect(
      schema.safeParse(file('text/plain', 4)).error?.issues.map((issue) => issue.message),
    ).toEqual(['File exceeds 3 bytes']);
    expect(schema.safeParse(file('application/json', 4)).error?.issues).toHaveLength(2);
  });
  it('reports only Expected a file for invalid shapes before refinements', () => {
    for (const value of [
      null,
      undefined,
      '',
      1,
      {},
      { filename: 1 },
      { filename: '', mimeType: 1 },
      { filename: '', mimeType: '' },
      { filename: '', mimeType: '', data: [] },
    ]) {
      expect(
        formFile({ mimeTypes: ['image/*'], maxBytes: 1 })
          .safeParse(value)
          .error?.issues.map((issue) => issue.message),
      ).toEqual(['Expected a file']);
    }
  });
  it('refuses invalid MIME essences and byte bounds at construction', () => {
    for (const mimeTypes of [
      [],
      ['image'],
      ['image/'],
      ['*/png'],
      ['*/*'],
      ['image/p*'],
      ['text/plain; charset=utf-8'],
      [' text/plain'],
      ['image/png/extra'],
    ]) {
      expect(() => formFile({ mimeTypes })).toThrow(/mimeTypes/);
    }
    expect(() => formFile({ mimeTypes: [1 as unknown as string] })).toThrow('mimeTypes entry: 1');
    for (const maxBytes of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => formFile({ maxBytes })).toThrow(`maxBytes: ${String(maxBytes)}`);
  });
});
