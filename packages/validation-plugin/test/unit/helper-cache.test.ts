import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { z } from 'zod-v4';
import type { IRequestContext, IValidationService } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  ValidationPlugin,
  validateBody,
  validateCookies,
  validateHeaders,
  validateParams,
  validateQuery,
} from '../../src/index.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
import * as validatorReader from '../../src/middleware/validator-reader.ts';
import { ValidationService } from '../../src/services/validation-service.ts';

type ServiceBuilder = Parameters<typeof validatorReader.registerServiceMiddleware>[1];

/** Wrap the actual registered builders without replacing the public middleware method. */
function spyOnBuilders(): Map<IValidationService, Mock<ServiceBuilder>> {
  const builds = new Map<IValidationService, Mock<ServiceBuilder>>();
  const register = validatorReader.registerServiceMiddleware;
  vi.spyOn(validatorReader, 'registerServiceMiddleware').mockImplementation((service, build) => {
    const spy = vi.fn(build);
    builds.set(service, spy);
    register(service, spy);
  });
  return builds;
}

afterEach(() => vi.restoreAllMocks());

describe('helper middleware cache through the real kernel', () => {
  for (const [helper, target] of [
    [validateBody, 'body'],
    [validateQuery, 'query'],
    [validateParams, 'params'],
    [validateHeaders, 'headers'],
    [validateCookies, 'cookies'],
  ] as const) {
    it(`${helper.name} builds once for five requests against one service`, async () => {
      const builds = spyOnBuilders();
      const schema = z.object({ count: z.coerce.number() }).passthrough();
      const options = { forms: true };
      const reader = target === 'body' ? validateBody(schema, options) : helper(schema);
      const app = createApplication();
      app.register(RuntimePlugin());
      app.register(ValidationPlugin({ whitelist: true }));
      app.router.post('/records/:count', {
        middleware: [reader],
        handler: (ctx) => ctx.response.json(reader.value(ctx)),
      });
      try {
        await app.start();
        const service = app.services.get<IValidationService>(CAPABILITIES.VALIDATION);
        for (let count = 1; count <= 5; count++) {
          const response = await app.inject({
            method: 'POST',
            url: `http://localhost/records/${count}?count=${count}&extra=removed`,
            headers: {
              'content-type': 'application/json',
              count: String(count),
              cookie: `count=${count}; extra=removed`,
            },
            body: { count, extra: 'removed' },
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ count });
        }
        expect(builds.size).toBe(1);
        expect(builds.get(service)).toHaveBeenCalledTimes(1);
        expect(builds.get(service)).toHaveBeenCalledWith(
          schema,
          target,
          expect.any(Object),
          target === 'body' ? options : undefined,
        );
      } finally {
        await app.stop();
      }
    });
  }

  it('builds once per service and preserves formats across interleaved child-registry overrides', async () => {
    const builds = spyOnBuilders();
    // Reuse the alternate object so both services receive repeated cache hits.
    const alternate = new ValidationService(rfc9457Formatter);
    const reader = validateBody(z.object({ name: z.string().min(1, 'Name is required') }));
    const handler = vi.fn((ctx: IRequestContext) => ctx.response.json(reader.value(ctx)));
    const app = createApplication();
    app.register(RuntimePlugin());
    app.register(ValidationPlugin({ errorFormat: 'default' }));
    app.router.post('/records', {
      middleware: [
        async (ctx, next) => {
          if (ctx.request.headers.get('x-alt-service') === '1') {
            ctx.services.register(CAPABILITIES.VALIDATION, alternate, { override: true });
          }
          await next();
        },
        reader,
      ],
      handler,
    });
    try {
      await app.start();
      const primary = app.services.get<IValidationService>(CAPABILITIES.VALIDATION);
      const errors = [{ field: 'name', message: 'Name is required', code: 'too_small' }];
      for (const useAlternate of [false, true, false, true, true, false]) {
        const response = await app.inject({
          method: 'POST',
          url: 'http://localhost/records',
          headers: useAlternate ? { 'x-alt-service': '1' } : {},
          body: { name: '' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual(
          useAlternate
            ? {
                type: 'https://setu-ts.dev/errors/validation',
                title: 'Validation Error',
                status: 400,
                detail: 'The request contains 1 validation error(s).',
                instance: '/records',
                errors,
              }
            : { message: 'Validation failed with 1 issue(s).', errors },
        );
        expect(response.headers.get('content-type')).toBe(
          useAlternate ? 'application/problem+json' : 'application/json; charset=utf-8',
        );
        expect(app.services.get(CAPABILITIES.VALIDATION)).toBe(primary);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(builds.size).toBe(2);
      expect(builds.get(primary)).toHaveBeenCalledTimes(1);
      expect(builds.get(alternate)).toHaveBeenCalledTimes(1);
    } finally {
      await app.stop();
    }
  });

  it('delegates after a middleware replacement and rebuilds when the registered method returns', async () => {
    const builds = spyOnBuilders();
    const alternate = new ValidationService(rfc9457Formatter);
    const schema = z.object({ name: z.string().min(1, 'Name is required') });
    const reader = validateBody(schema);
    const handler = vi.fn((ctx: IRequestContext) => ctx.response.json(reader.value(ctx)));
    const app = createApplication();
    app.register(RuntimePlugin());
    app.register(ValidationPlugin());
    app.router.post('/records', { middleware: [reader], handler });
    try {
      await app.start();
      const service = app.services.get<IValidationService>(CAPABILITIES.VALIDATION);
      const original = service.middleware;
      const request = {
        method: 'POST' as const,
        url: 'http://localhost/records',
        body: { name: '' },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(400);
      expect(first.json()).toHaveProperty('message', 'Validation failed with 1 issue(s).');
      expect(builds.get(service)).toHaveBeenCalledTimes(1);

      const replacement = vi.fn(alternate.middleware.bind(alternate));
      service.middleware = replacement;
      for (let count = 1; count <= 3; count++) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toHaveProperty('type', 'https://setu-ts.dev/errors/validation');
        expect(response.json()).not.toHaveProperty('message');
        expect(replacement).toHaveBeenCalledTimes(count);
        expect(replacement).toHaveBeenLastCalledWith(schema, 'body', undefined);
        expect(builds.get(service)).toHaveBeenCalledTimes(1);
      }

      service.middleware = original;
      const restored = await app.inject(request);
      expect(restored.statusCode).toBe(400);
      expect(restored.json()).toHaveProperty('message', 'Validation failed with 1 issue(s).');
      expect(builds.get(service)).toHaveBeenCalledTimes(2);
      expect(replacement).toHaveBeenCalledTimes(3);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });

  it('calls third-party middleware once per request and retains the outer reader and options', async () => {
    const delegate = new ValidationService(defaultFormatter);
    const middleware = vi.fn(delegate.middleware.bind(delegate));
    const service: IValidationService = {
      validate: delegate.validate.bind(delegate),
      middleware,
    };
    const schema = z.object({ name: z.string().min(1, 'Name is required') });
    const options = { forms: true };
    const reader = validateBody(schema, options);
    const handler = vi.fn((ctx: IRequestContext) => ctx.response.json(reader.value(ctx)));
    const app = createApplication();
    app.register(RuntimePlugin());
    app.register({
      name: 'third-party-validation',
      version: '1.0.0',
      provides: [CAPABILITIES.VALIDATION],
      register(ctx) {
        ctx.services.register(CAPABILITIES.VALIDATION, service);
      },
    });
    app.router.post('/records', { middleware: [reader], handler });
    try {
      await app.start();
      for (const [index, name] of ['Ada', '', 'Grace', '', 'Lin'].entries()) {
        const response = await app.inject({
          method: 'POST',
          url: 'http://localhost/records',
          body: { name },
        });
        expect(response.statusCode).toBe(name === '' ? 400 : 200);
        expect(response.json()).toEqual(
          name === ''
            ? {
                message: 'Validation failed with 1 issue(s).',
                errors: [{ field: 'name', message: 'Name is required', code: 'too_small' }],
              }
            : { name },
        );
        expect(middleware).toHaveBeenCalledTimes(index + 1);
        expect(middleware).toHaveBeenLastCalledWith(schema, 'body', options);
      }
      expect(handler).toHaveBeenCalledTimes(3);
    } finally {
      await app.stop();
    }
  });
});
