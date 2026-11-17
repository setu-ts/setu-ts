import { describe, expect, it } from 'vitest';
import { encodeMultipart } from '../../src/http/multipart.ts';

describe('encodeMultipart', () => {
  it('encodes own enumerable fields in insertion order, repeats arrays and skips undefined', async () => {
    const body: Record<string, unknown> = Object.assign(
      {},
      {
        title: 'hello',
        skip: undefined,
        count: 3,
        enabled: true,
        no: false,
        big: 12n,
        files: [new File(['one'], 'one.txt', { type: 'text/plain' }), undefined, new Blob(['two'])],
        tags: ['a', 2, false, 1n],
        empty: [],
      },
    );
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

  it('sends a FormData as given and refuses a body that is not a plain object', () => {
    const form = new FormData();
    form.append('title', 'hello');
    expect(encodeMultipart(form)).toBe(form);
    const bare = Object.assign(Object.create(null) as object, { title: 'x' });
    expect([...encodeMultipart(bare).keys()]).toEqual(['title']);
    for (const body of [
      new URLSearchParams('a=1'),
      new Map([['a', '1']]),
      [],
      new Date(),
      new (class Upload {
        title = 'x';
      })(),
    ]) {
      expect(() => encodeMultipart(body), body.constructor.name).toThrow(
        'multipart must be a FormData or a plain object of form fields',
      );
    }
  });
});
