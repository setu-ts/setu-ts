import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { CAPABILITIES, validatedStateKey } from '@setu-ts/common';
import { createValidationMiddleware, validateBody, validateQuery } from '../../src/index.ts';
import type { ValidatedOutput } from '../../src/index.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

describe('validator instance reader', () => {
  const schema = z.object({ limit: z.coerce.number().default(20) });
  it('reads coerced and defaulted outputs from its own successful run', async () => {
    for (const query of [{ limit: '3' }, {}]) {
      const { ctx } = createFakeContext({ query });
      const validator = createValidationMiddleware(
        schema,
        'query',
        new ValidationService(defaultFormatter),
        defaultFormatter,
      );
      await validator(ctx, async () => {});
      const value: ValidatedOutput<typeof schema> = validator.value(ctx);
      expect(value.limit).toBe('limit' in query ? 3 : 20);
      // @ts-expect-error The parsed output is numeric.
      const wrong: { limit: string } = validator.value(ctx);
      void wrong;
    }
  });
  it('throws for an absent run and manually supplied state', () => {
    const { ctx } = createFakeContext();
    const validator = validateQuery(schema);
    expect(() => validator.value(ctx)).toThrow(
      'Validator for query did not run or was overwritten',
    );
    ctx.state.set(validatedStateKey('query'), { limit: 20 });
    expect(() => validator.value(ctx)).toThrow(TypeError);
  });
  it('rejects another instance even when it uses the identical schema', async () => {
    const { ctx } = createFakeContext({ query: {} });
    ctx.services.register(CAPABILITIES.VALIDATION, new ValidationService(defaultFormatter));
    const first = validateQuery(schema);
    const second = validateQuery(schema);
    await first(ctx, async () => {});
    expect(first.value(ctx)).toEqual({ limit: 20 });
    await second(ctx, async () => {});
    expect(() => first.value(ctx)).toThrow(TypeError);
    expect(second.value(ctx)).toEqual({ limit: 20 });
  });
  it('reads a parsed undefined output', async () => {
    const { ctx } = createFakeContext();
    const validator = createValidationMiddleware(
      z.unknown().transform(() => undefined),
      'query',
      new ValidationService(defaultFormatter),
      defaultFormatter,
    );
    await validator(ctx, async () => {});
    expect(validator.value(ctx)).toBeUndefined();
  });
  it('preserves third-party service delegation and stamps only successful continuations', async () => {
    const { ctx } = createFakeContext({ request: { body: { name: 'Ada' } } });
    const service = new ValidationService(defaultFormatter);
    ctx.services.register(CAPABILITIES.VALIDATION, {
      validate: service.validate.bind(service),
      middleware:
        (schema: unknown, target: import('@setu-ts/common').ValidationTarget) =>
        (context: import('@setu-ts/common').IRequestContext, next: () => Promise<void>) =>
          service.middleware(schema, target)(context, next),
    });
    const body = validateBody(z.object({ name: z.string() }));
    let read: unknown;
    await body(ctx, () => {
      read = body.value(ctx);
      return Promise.resolve();
    });
    expect(read).toEqual({ name: 'Ada' });
    const invalid = validateBody(z.string());
    let continued = false;
    await invalid(ctx, () => {
      continued = true;
      return Promise.resolve();
    });
    expect(continued).toBe(false);
    expect(() => invalid.value(ctx)).toThrow(TypeError);
  });

  it('refuses a value rewritten under the common key after its own run', async () => {
    const { ctx } = createFakeContext({ query: { limit: '3' } });
    const validator = createValidationMiddleware(
      schema,
      'query',
      new ValidationService(defaultFormatter),
      defaultFormatter,
    );
    await validator(ctx, () => {
      // A conformant third-party validator, or any middleware, writes only the
      // common key — the reader must not hand that value out as its own.
      ctx.state.set(validatedStateKey('query'), { limit: 999, isAdmin: true });
      return Promise.resolve();
    });
    expect(() => validator.value(ctx)).toThrow(TypeError);
  });
  it('reads a NaN output, which === alone would report as overwritten', async () => {
    const { ctx } = createFakeContext({ query: {} });
    const nan = z.object({}).transform(() => Number.NaN);
    const validator = createValidationMiddleware(
      nan,
      'query',
      new ValidationService(defaultFormatter),
      defaultFormatter,
    );
    await validator(ctx, async () => {});
    expect(validator.value(ctx)).toBeNaN();
  });
  it('forwards per-validator options to a third-party service', async () => {
    const seen: unknown[] = [];
    const service = new ValidationService(defaultFormatter);
    const { ctx } = createFakeContext({ request: { body: { name: 'Ada' } } });
    ctx.services.register(CAPABILITIES.VALIDATION, {
      validate: service.validate.bind(service),
      middleware:
        (
          schema: unknown,
          target: import('@setu-ts/common').ValidationTarget,
          options?: import('@setu-ts/common').ValidationMiddlewareOptions,
        ) =>
        (context: import('@setu-ts/common').IRequestContext, next: () => Promise<void>) => {
          seen.push(options);
          return service.middleware(schema, target, options)(context, next);
        },
    });
    const body = validateBody(z.object({ name: z.string() }), { forms: true });
    await body(ctx, async () => {});
    expect(seen).toEqual([{ forms: true }]);
    expect(body.value(ctx)).toEqual({ name: 'Ada' });
  });
});
