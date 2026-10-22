import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod-v4';
import { parseFormBody } from '@setu-ts/common';
import { createValidationMiddleware } from '../../src/index.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

describe('validated body media types', () => {
  for (const forms of [false, true]) {
    for (const [header, kind] of [
      ['application/json', 'json'],
      ['APPLICATION/JSON; charset=utf-8', 'json'],
      ['application/vnd.api+json', 'json'],
      ['Application/Problem+JSON; charset=UTF-8', 'json'],
      ['application/x-www-form-urlencoded', 'form'],
      ['multipart/form-data; boundary=b', 'form'],
      ['text/plain', 'refused'],
      ['text/json', 'refused'],
      ['application/jsonx', 'refused'],
      ['application/+json', 'refused'],
      ['multipart/mixed; boundary=b', 'refused'],
      [undefined, 'refused'],
    ] as const) {
      it(`${String(header)} with forms=${forms}`, async () => {
        const fake = createFakeContext({ request: { body: { name: 'Ada' } } });
        if (header === undefined) fake.ctx.request.headers.delete('content-type');
        else fake.ctx.request.headers.set('content-type', header);
        const json = vi.spyOn(fake.ctx.request, 'json');
        const text = vi.spyOn(fake.ctx.request, 'text');
        const bytes = vi.spyOn(fake.ctx.request, 'bytes');
        const formData = vi.fn(() =>
          Promise.resolve(
            parseFormBody(
              new TextEncoder().encode('name=Ada'),
              'application/x-www-form-urlencoded',
            ),
          ),
        );
        const ctx = { ...fake.ctx, request: { ...fake.ctx.request, formData } };
        const formatter = vi.fn(defaultFormatter);
        const service = new ValidationService(formatter);
        const validate = vi.spyOn(service, 'validate');
        const reader = createValidationMiddleware(
          z.object({ name: z.string() }),
          'body',
          service,
          formatter,
          { forms },
        );
        const next = vi.fn();
        await reader(ctx, next);
        const accepted = kind === 'json' || (kind === 'form' && forms);
        expect(next).toHaveBeenCalledTimes(Number(accepted));
        expect(json).toHaveBeenCalledTimes(Number(kind === 'json'));
        expect(formData).toHaveBeenCalledTimes(Number(kind === 'form' && forms));
        expect(text).not.toHaveBeenCalled();
        expect(bytes).not.toHaveBeenCalled();
        expect(formatter).not.toHaveBeenCalled();
        expect(validate).toHaveBeenCalledTimes(Number(accepted));
        if (accepted) expect(reader.value(ctx)).toEqual({ name: 'Ada' });
        else {
          expect(fake.responseSnapshot().status).toBe(415);
          expect(JSON.parse(fake.responseSnapshot().body ?? '')).toEqual({
            error: 'Unsupported Media Type',
            detail: forms
              ? 'Expected a JSON or form request body.'
              : 'Expected a JSON request body (application/json).',
          });
          expect(() => reader.value(ctx)).toThrow(TypeError);
        }
      });
    }
  }
  it('leaves non-body targets independent of content-type', async () => {
    for (const target of ['query', 'params', 'headers', 'cookies'] as const) {
      const fake = createFakeContext();
      const next = vi.fn();
      await createValidationMiddleware(
        z.object({}),
        target,
        new ValidationService(defaultFormatter),
        defaultFormatter,
      )(fake.ctx, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
  it('defaults only a supplied fake body to JSON and preserves explicit headers', () => {
    expect(
      createFakeContext({ request: { body: {} } }).ctx.request.headers.get('content-type'),
    ).toBe('application/json');
    expect(createFakeContext().ctx.request.headers.has('content-type')).toBe(false);
    expect(
      createFakeContext({
        request: { body: {}, headers: { 'Content-Type': 'text/plain' } },
      }).ctx.request.headers.get('content-type'),
    ).toBe('text/plain');
  });
});
