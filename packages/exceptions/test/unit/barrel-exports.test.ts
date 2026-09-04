/**
 * Barrel-export test for `@setu-ts/exceptions`.
 *
 * The barrel IS the public API (AI_GUIDELINES §10.1), but every other test in
 * this package imports the concrete module rather than `src/index.ts`. Dropping
 * a symbol from the barrel therefore passed `deno check`, the whole suite, the
 * per-file coverage bar (a re-export file is fully covered merely by being
 * loaded), and `publish:check` — while making that symbol unimportable for
 * consumers. This file closes that gap.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as api from '../../src/index.ts';

describe('exceptions barrel exports', () => {
  it('exports every documented runtime symbol', () => {
    const expected = [
      'HttpError',
      'badRequest',
      'conflict',
      'forbidden',
      'internalServerError',
      'notFound',
      'notImplemented',
      'serviceUnavailable',
      'STATUS_TITLES',
      'statusTitle',
      'tooManyRequests',
      'unauthorized',
      'validationError',
      'defaultFormatter',
      'selectFormatter',
      'rfc9457Formatter',
      'rfc7807Formatter',
      'ERROR_TYPE_BASE',
      'errorHandler',
    ] as const;

    for (const name of expected) {
      expect(typeof (api as Record<string, unknown>)[name]).not.toBe('undefined');
    }
  });

  it('does NOT leak the internal Problem Details core', () => {
    // `buildProblemDetails`, `VALIDATION_TYPE` and `ABOUT_BLANK` are the seam
    // the two formatters share, not public surface, and are absent from
    // PUBLIC_API.md. Exporting one by accident would silently widen the
    // published API.
    // `createErrorResponder` is the exceptions implementation of the request-
    // scoped responder seam (M70f). The interface it satisfies lives in
    // `@setu-ts/common`; exporting the implementation would give one concept two
    // public names, so it stays out of the barrel (plan §4, §6).
    const internal = [
      'buildProblemDetails',
      'VALIDATION_TYPE',
      'ABOUT_BLANK',
      'createErrorResponder',
      // `buildErrorFromInit` is the one owner of the
      // `{ status, title, detail }` -> `HttpError` mapping, shared by the
      // responder and `errorHandler`'s M89b status-hint path. It is an
      // implementation detail of both; a package that needs the behaviour
      // reaches `respondWithError` or brands with `withHttpStatusHint`.
      'buildErrorFromInit',
    ] as const;

    for (const name of internal) {
      expect((api as Record<string, unknown>)[name]).toBe(undefined);
    }
  });

  it('resolves both Problem Details formatters through the barrel', () => {
    // Reaching the formatters the way a consumer does — rather than through a
    // deep module path — is what proves the barrel actually re-exports them,
    // and that the two remain distinct implementations.
    const { ERROR_TYPE_BASE, notFound, rfc7807Formatter, rfc9457Formatter } = api;

    expect(rfc9457Formatter(notFound('gone')).type).toBe('about:blank');
    expect(rfc7807Formatter(notFound('gone')).type).toBe(`${ERROR_TYPE_BASE}/404`);
  });
});
