import { describe, expect, it } from 'vitest';
import { encodeMultipart } from '../../src/http/multipart.ts';

describe('encodeMultipart', () => {
  it('encodes own enumerable fields in insertion order, repeats arrays and skips undefined', async () => {
    const body = Object.assign(Object.create({ inherited: 'hidden' }) as Record<string, unknown>, {
      title: 'hello',
      skip: undefined,
      count: 3,
      enabled: true,
      no: false,
      big: 12n,
      files: [new File(['one'], 'one.txt', { type: 'text/plain' }), undefined, new Blob(['two'])],
      tags: ['a', 2, false, 1n],
      empty: [],
    });
    Object.defineProperty(body, 'hidden', { value: 'hidden', enumerable: false });
    const form = encodeMultipart(body);
    expect([...form.keys()]).toEqual([
      'title',
      'count',
      'enabled',
      'no',
      'big',
      'files',
      'files',
      'tags',
      'tags',
      'tags',
      'tags',
    ]);
    expect(form.getAll('tags')).toEqual(['a', '2', 'false', '1']);
    expect(['title', 'count', 'enabled', 'no', 'big'].map((key) => form.get(key))).toEqual([
      'hello',
      '3',
      'true',
      'false',
      '12',
    ]);
    const files = form.getAll('files') as File[];
    expect(files.map((file) => file.name)).toEqual(['one.txt', 'blob']);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['one', 'two']);
  });
  it('refuses null, nested arrays, other objects, functions and symbols, naming the field', () => {
    for (const value of [null, {}, new Date(0), [[]], [null], [{}], () => {}, Symbol('file')]) {
      expect(() => encodeMultipart({ upload: value })).toThrow(/upload/);
    }
  });
});
