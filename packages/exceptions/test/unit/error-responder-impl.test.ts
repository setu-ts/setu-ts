/**
 * Unit tests for `createErrorResponder` — the `exceptions` implementation of
 * the request-scoped error responder seam (M70f).
 *
 * The responder is the half of the seam that runs INSIDE the pipeline: a
 * short-circuiting site calls `respondWithError`, which finds the responder
 * `errorHandler` published in `ctx.state` and delegates to it. This file
 * exercises the responder directly (the factory and its `respond` closure),
 * asserting it writes the status, the resolved content type, and the
 * formatter's serialized body — the same three-step tail `errorHandler`'s
 * catch path performs.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createErrorResponder } from '../../src/middleware/error-responder-impl.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

describe('createErrorResponder', () => {
  it('returns a responder object exposing a respond function', () => {
    const responder = createErrorResponder(rfc9457Formatter, 'application/problem+json');
    expect(typeof responder).toBe('object');
    expect(typeof responder.respond).toBe('function');
  });

  it('writes the status, content type, and serialized Problem Details body', () => {
    const responder = createErrorResponder(rfc9457Formatter, 'application/problem+json');
    const { ctx, responseSnapshot } = createFakeContext({
      request: { path: '/users/42' },
    });

    responder.respond(ctx, { status: 404, title: 'Not Found' });

    const snap = responseSnapshot();
    expect(snap.status).toBe(404);
    expect(snap.headers.get('content-type')).toBe('application/problem+json');
    const body = JSON.parse(new TextDecoder().decode(snap.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    // The responder builds a real HttpError from the init, so the formatter
    // sees a genuine 404 (never masked) and derives `instance` from the path.
    expect(body.type).toBe('about:blank');
    expect(body.status).toBe(404);
    expect(body.instance).toBe('/users/42');
  });

  it('surfaces a validation `errors` extension as the validation problem type', () => {
    const responder = createErrorResponder(rfc9457Formatter, 'application/problem+json');
    const { ctx, responseSnapshot } = createFakeContext({
      request: { path: '/signup' },
    });

    responder.respond(ctx, {
      status: 400,
      title: 'Bad Request',
      details: { errors: [{ path: 'email', message: 'invalid' }] },
    });

    const snap = responseSnapshot();
    const body = JSON.parse(new TextDecoder().decode(snap.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    // A body carrying an `errors` extension is a distinct problem type.
    expect(body.type).toBe('https://setu-ts.dev/errors/validation');
    expect(body.status).toBe(400);
    expect(body.errors).toEqual([{ path: 'email', message: 'invalid' }]);
  });

  it('honours a non-Problem-Details content type', () => {
    const responder = createErrorResponder(rfc9457Formatter, 'application/json; charset=utf-8');
    const { ctx, responseSnapshot } = createFakeContext({});

    responder.respond(ctx, { status: 503, title: 'Service Unavailable' });

    const snap = responseSnapshot();
    expect(snap.status).toBe(503);
    expect(snap.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});
