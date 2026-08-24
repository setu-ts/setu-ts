/**
 * Both validation entry points carry the same brand (M70m/X11-5, plan §3.2).
 *
 * `validateBody(...)` and `service.middleware(schema, target)` are two ways to
 * reach one behaviour, and CLAUDE.md's self-review checklist requires one test
 * driving BOTH under a non-default configuration: a split where only one is
 * branded passes every gate while the OpenAPI document silently loses the
 * routes that used the other form.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IValidationService, MiddlewareFunction, ValidationTarget } from '@setu-ts/common';
import { CAPABILITIES, validationMetadataOf } from '@setu-ts/common';

import {
  createValidationMiddleware,
  validateBody,
  validateCookies,
  validateHeaders,
  validateParams,
  validateQuery,
} from '../../src/middleware/validation-middleware.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

/** A schema shaped like Zod's `safeParse` surface, refusing everything. */
function refusingSchema() {
  return {
    safeParse(_data: unknown) {
      return { success: false as const, error: { issues: [{ path: [], message: 'nope' }] } };
    },
  };
}

/** A schema that accepts anything. */
function acceptingSchema() {
  return {
    safeParse(data: unknown) {
      return { success: true as const, data };
    },
  };
}

const HELPERS: readonly [ValidationTarget, (schema: unknown) => MiddlewareFunction][] = [
  ['body', validateBody],
  ['query', validateQuery],
  ['params', validateParams],
  ['headers', validateHeaders],
  ['cookies', validateCookies],
];

describe('validation metadata brand', () => {
  it('brands every convenience helper with its own target and schema', () => {
    for (const [target, helper] of HELPERS) {
      const schema = acceptingSchema();

      expect(validationMetadataOf(helper(schema))).toEqual({ target, schema });
    }
  });

  it('brands the service entry point identically', () => {
    // The other way to reach the same middleware. Both must agree, or a
    // document derived from route middleware sees only half the routes.
    const service: IValidationService = new ValidationService(rfc9457Formatter);
    for (const [target] of HELPERS) {
      const schema = acceptingSchema();

      expect(validationMetadataOf(service.middleware(schema, target))).toEqual({ target, schema });
    }
  });

  it('brands the core factory under a NON-default formatter', () => {
    // Driven with `rfc9457Formatter` rather than the default, so the brand is
    // proven independent of the error format the plugin was configured with.
    const schema = acceptingSchema();
    const service: IValidationService = new ValidationService(rfc9457Formatter);
    const middleware = createValidationMiddleware(schema, 'body', service, rfc9457Formatter);

    expect(validationMetadataOf(middleware)).toEqual({ target: 'body', schema });
  });

  it('agrees across BOTH entry points for the same (schema, target)', () => {
    const schema = acceptingSchema();
    const service: IValidationService = new ValidationService(defaultFormatter);

    expect(validationMetadataOf(validateBody(schema)))
      .toEqual(validationMetadataOf(service.middleware(schema, 'body')));
  });

  it('does not change the short-circuit behaviour it brands', async () => {
    // The brand is a DESCRIPTION. A failing body must still answer 400 and
    // must still not call `next()`.
    const service: IValidationService = new ValidationService(defaultFormatter);
    const middleware = validateBody(refusingSchema());
    const { ctx, responseSnapshot } = createFakeContext({
      request: { body: { a: 1 } },
      services: new Map([[CAPABILITIES.VALIDATION, service]]),
    });

    let nextRan = false;
    await middleware(ctx, () => {
      nextRan = true;
      return Promise.resolve();
    });

    expect(nextRan).toBe(false);
    expect(responseSnapshot().status).toBe(400);
  });

  it('does not change the success path it brands', async () => {
    const service: IValidationService = new ValidationService(defaultFormatter);
    const middleware = validateBody(acceptingSchema());
    const { ctx } = createFakeContext({
      request: { body: { a: 1 } },
      services: new Map([[CAPABILITIES.VALIDATION, service]]),
    });

    let nextRan = false;
    await middleware(ctx, () => {
      nextRan = true;
      return Promise.resolve();
    });

    expect(nextRan).toBe(true);
    expect(ctx.state.get('validated:body')).toEqual({ a: 1 });
  });
});
