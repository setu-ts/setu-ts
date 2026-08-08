/**
 * Barrel-export test for `@setu-ts/validation-plugin`.
 *
 * The barrel IS the public API (AI_GUIDELINES §10.1). The only test that
 * imported `src/index.ts` pulled three symbols from it, so dropping any other
 * export — including `rfc9457Formatter` — passed every gate while making it
 * unimportable for consumers. This file closes that gap.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as api from '../../src/index.ts';

describe('validation-plugin barrel exports', () => {
  it('exports every documented runtime symbol', () => {
    const expected = [
      'ValidationPlugin',
      'ValidationService',
      'createValidationMiddleware',
      'validateBody',
      'validateCookies',
      'validateHeaders',
      'validateParams',
      'validateQuery',
      'createSanitizer',
      'sanitize',
      'defaultFormatter',
      'nestjsFormatter',
      'rfc9457Formatter',
      'rfc7807Formatter',
      'resolveFormatter',
    ] as const;

    for (const name of expected) {
      expect(typeof (api as Record<string, unknown>)[name]).not.toBe('undefined');
    }
  });

  it('resolves the Problem Details formatter through the barrel', () => {
    const { rfc9457Formatter, resolveFormatter } = api;
    const body = rfc9457Formatter([{ path: 'email', message: 'Invalid email' }]);

    expect(body.type).toBe('https://setu-ts.dev/errors/validation');
    expect(resolveFormatter('rfc9457')).toBe(rfc9457Formatter);
  });

  it('keeps the deprecated alias bound to the same object through the barrel', () => {
    // Here — unlike @setu-ts/exceptions — the two names are one implementation,
    // which is what lets validation-middleware.ts carry a single entry in its
    // media-type membership set. A consumer must see that too.
    expect(api.rfc7807Formatter).toBe(api.rfc9457Formatter);
  });
});
