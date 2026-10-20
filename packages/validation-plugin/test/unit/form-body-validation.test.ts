import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod-v4';
import { parseFormBody } from '@setu-ts/common';
import * as contentType from '../../../common/src/form/content-type.ts';
import { formRecord } from '../../src/middleware/form-record.ts';
import { createValidationMiddleware } from '../../src/index.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
afterEach(() => vi.restoreAllMocks());
describe('form body validation', () => {
  for (const [body, expected] of [
    ['name=Ada', { name: 'Ada' }],
    ['tag=a&tag=b&tag=c', { tag: ['a', 'b', 'c'] }],
    ['tag[]=a', { 'tag[]': ['a'] }],
    ['tag[]=a&tag[]=b', { 'tag[]': ['a', 'b'] }],
    ['', {}],
  ] as const) {
    it(`converts ordered form fields ${body}`, () => {
      const result = formRecord(parseFormBody(encode(body), 'application/x-www-form-urlencoded'));
      expect(result).toEqual(expected);
      expect(Object.getPrototypeOf(result)).toBeNull();
    });
  }
  it('keeps prototype-looking names as literal own keys', () => {
    const result = formRecord(
      parseFormBody(
        encode(
          '__proto__=one&__proto__=two&constructor=x&prototype=y&__proto__[x]=1&constructor.prototype.x=1',
        ),
        'application/x-www-form-urlencoded',
      ),
    );
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result['__proto__']).toEqual(['one', 'two']);
    expect(Object.keys(result)).toEqual([
      '__proto__',
      'constructor',
      'prototype',
      '__proto__[x]',
      'constructor.prototype.x',
    ]);
    expect(Object.hasOwn({}, 'x')).toBe(false);
  });
  it('preserves a file part without converting it to a string', () => {
    const form = parseFormBody(
      encode(
        '--b\r\nContent-Disposition: form-data; name="upload"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n',
      ),
      'multipart/form-data; boundary=b',
    );
    expect(formRecord(form)['upload']).toEqual({
      filename: 'a.txt',
      mimeType: 'text/plain',
      data: encode('hello'),
    });
  });
  it('validates both encodings and leading whitespace/case without reading JSON', async () => {
    for (const header of [
      'application/x-www-form-urlencoded',
      ' Multipart/Form-Data; boundary=b',
    ]) {
      const fake = createFakeContext({ request: { headers: { 'content-type': header } } });
      const json = vi.spyOn(fake.ctx.request, 'json');
      const ctx = {
        ...fake.ctx,
        request: {
          ...fake.ctx.request,
          formData: () =>
            Promise.resolve(parseFormBody(encode('count=3'), 'application/x-www-form-urlencoded')),
        },
      };
      const reader = createValidationMiddleware(
        z.object({ count: z.coerce.number() }),
        'body',
        new ValidationService(defaultFormatter),
        defaultFormatter,
      );
      await reader(ctx, async () => {});
      expect(reader.value(ctx)).toEqual({ count: 3 });
      expect(json).not.toHaveBeenCalled();
    }
  });
  it('answers 400 and never continues when formData is absent or fails', async () => {
    for (const accessor of [undefined, () => Promise.reject(new Error('malformed'))]) {
      const fake = createFakeContext({
        request: { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      });
      const ctx = {
        ...fake.ctx,
        request: { ...fake.ctx.request, ...(accessor === undefined ? {} : { formData: accessor }) },
      };
      const next = vi.fn();
      await createValidationMiddleware(
        z.object({}),
        'body',
        new ValidationService(defaultFormatter),
        defaultFormatter,
      )(ctx, next);
      expect(fake.responseSnapshot().status).toBe(400);
      expect(fake.responseSnapshot().body).toContain('Unsupported form body');
      expect(next).not.toHaveBeenCalled();
    }
  });
  it('never reaches parseContentType on the unchanged JSON path', async () => {
    const spy = vi.spyOn(contentType, 'parseContentType');
    for (const header of [
      'application/json',
      'text/plain',
      'application/x-www-form-urlencoded-v2',
      'multipart/mixed',
    ]) {
      const fake = createFakeContext({
        request: { body: { count: 3 }, headers: { 'content-type': header } },
      });
      const reader = createValidationMiddleware(
        z.object({ count: z.number() }),
        'body',
        new ValidationService(defaultFormatter),
        defaultFormatter,
      );
      await reader(fake.ctx, async () => {});
      expect(reader.value(fake.ctx)).toEqual({ count: 3 });
      if (header === 'application/json') expect(spy).not.toHaveBeenCalled();
    }
  });
});
