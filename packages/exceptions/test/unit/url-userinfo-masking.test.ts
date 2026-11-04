/** Regression tests for URL userinfo masking at both error-serving boundaries. */
import { describe, expect, it } from 'vitest';
import { respondWithError } from '@setu-ts/common';

import { HttpError } from '../../src/errors/http-error.ts';
import { selectFormatter } from '../../src/formatters/error-formatter.ts';
import { errorHandler } from '../../src/middleware/error-handler.ts';
import { createErrorResponder } from '../../src/middleware/error-responder-impl.ts';
import { maskUrlUserinfoDeep } from '../../src/middleware/mask-url-userinfo-deep.ts';
import { createFakeContext, createFakeResponse } from '../fixtures/fake-runtime.ts';

const CONNECTION_URL = 'postgres://app:s3cretPW@db.internal:5432/app';
const MASKED_URL = 'postgres://***@db.internal:5432/app';

function responseText(body: Uint8Array | string | null): string {
  expect(body).not.toBeNull();
  return typeof body === 'string' ? body : new TextDecoder().decode(body ?? undefined);
}

function expectMasked(text: string): void {
  expect(text).not.toContain('s3cretPW');
  expect(text).toContain('db.internal');
  expect(text).toContain(MASKED_URL);
}

describe('maskUrlUserinfoDeep', () => {
  it('copies deeply frozen nested objects and arrays without mutating them', () => {
    const nested = Object.freeze({ connection: CONNECTION_URL });
    const innerArray = Object.freeze([CONNECTION_URL]);
    const items = Object.freeze([CONNECTION_URL, nested, innerArray]);
    const body = Object.freeze({ message: CONNECTION_URL, nested, items });

    const masked = maskUrlUserinfoDeep(body);

    expect(masked).toEqual({
      message: MASKED_URL,
      nested: { connection: MASKED_URL },
      items: [MASKED_URL, { connection: MASKED_URL }, [MASKED_URL]],
    });
    expect(masked).not.toBe(body);
    expect(masked.nested).not.toBe(nested);
    expect(masked.items).not.toBe(items);
    expect(body.message).toBe(CONNECTION_URL);
    expect(body.nested.connection).toBe(CONNECTION_URL);
    expect(body.items).toEqual([CONNECTION_URL, nested, [CONNECTION_URL]]);
  });

  it('preserves non-string scalars, Dates and class instances by identity', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const instance = new HttpError(400, CONNECTION_URL);
    const body = { count: 42, enabled: false, empty: null, missing: undefined, date, instance };

    const masked: Record<string, unknown> = maskUrlUserinfoDeep(body);

    for (const [key, value] of Object.entries(body)) {
      expect(masked[key]).toBe(value);
    }
    expect(instance.message).toBe(CONNECTION_URL);
  });

  it('walks null-prototype objects and preserves keys, including __proto__', () => {
    const nested = Object.assign(Object.create(null) as Record<string, unknown>, {
      connection: CONNECTION_URL,
    });
    const body = Object.fromEntries<unknown>([
      [CONNECTION_URL, CONNECTION_URL],
      ['__proto__', nested],
    ]);

    const masked = maskUrlUserinfoDeep(body);

    expect(Object.keys(masked)).toEqual([CONNECTION_URL, '__proto__']);
    expect(masked[CONNECTION_URL]).toBe(MASKED_URL);
    expect(Object.hasOwn(masked, '__proto__')).toBe(true);
    expect(masked.__proto__).toEqual({ connection: MASKED_URL });
    expect(masked.__proto__).not.toBe(nested);
    expect(nested.connection).toBe(CONNECTION_URL);
  });

  it('leaves plain text unchanged', () => {
    expect(maskUrlUserinfoDeep({ message: 'Payment gateway timed out' })).toEqual({
      message: 'Payment gateway timed out',
    });
  });
});

describe('served error bodies', () => {
  for (const format of ['default', 'rfc9457'] as const) {
    for (const status of [400, 502] as const) {
      for (const includeStackTrace of [false, true]) {
        it(`masks thrown HttpError ${status} under ${format}, stack=${includeStackTrace}`, async () => {
          const { ctx, responseSnapshot } = createFakeContext();
          const cause = new Error(`Driver failed at ${CONNECTION_URL}`);
          const error = new HttpError(
            status,
            cause.message,
            {
              connection: CONNECTION_URL,
              errors: [{ field: 'connection', message: CONNECTION_URL }],
            },
            status === 502 ? cause : undefined,
          );
          const middleware = errorHandler({ format, includeStackTrace, logErrors: false });

          await middleware(ctx, () => {
            throw error;
          });

          const snapshot = responseSnapshot();
          const text = responseText(snapshot.body);
          expectMasked(text);
          expect(snapshot.status).toBe(status);
          const body = JSON.parse(text) as Record<string, unknown>;
          if (format === 'default') {
            expect(body.statusCode).toBe(status);
            expect(body.message).toBe(`Driver failed at ${MASKED_URL}`);
            expect(body.details).toEqual({
              connection: MASKED_URL,
              errors: [{ field: 'connection', message: MASKED_URL }],
            });
          } else {
            expect(body.type).toBe('https://setu-ts.dev/errors/validation');
            expect(body.title).toBe(status === 400 ? 'Bad Request' : 'Bad Gateway');
            expect(body.status).toBe(status);
            expect(body.detail).toBe(`Driver failed at ${MASKED_URL}`);
            expect(body.instance).toBe('/');
            expect(body.errors).toEqual([{ field: 'connection', message: MASKED_URL }]);
            expect(body).not.toHaveProperty('message');
          }
          if (includeStackTrace) {
            expect(typeof body.stack).toBe('string');
            expect(body.stack).not.toContain('s3cretPW');
            expect(body.stack).toContain(MASKED_URL);
          } else {
            expect(body).not.toHaveProperty('stack');
          }
          expect(error.message).toBe(cause.message);
          expect(error.details?.connection).toBe(CONNECTION_URL);
        });
      }
    }

    it(`masks responder detail under ${format} through respondWithError`, async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const middleware = errorHandler({ format, logErrors: false });

      await middleware(ctx, () => {
        respondWithError(ctx, { status: 502, title: 'Bad Gateway', detail: CONNECTION_URL });
        return Promise.resolve();
      });

      expect(responseSnapshot().status).toBe(502);
      expectMasked(responseText(responseSnapshot().body));
    });

    it(`masks responder detail under ${format} through createErrorResponder`, () => {
      const { ctx, responseSnapshot } = createFakeContext();
      const contentType =
        format === 'rfc9457' ? 'application/problem+json' : 'application/json; charset=utf-8';
      const responder = createErrorResponder(selectFormatter(format), contentType);

      responder.respond(ctx, { status: 400, title: 'Bad Request', detail: CONNECTION_URL });

      expect(responseSnapshot().status).toBe(400);
      expectMasked(responseText(responseSnapshot().body));
    });
  }

  it('masks frozen custom formatter output that returns the message verbatim', async () => {
    const { ctx, responseSnapshot } = createFakeContext();
    const shared = Object.freeze({ connection: CONNECTION_URL });
    const middleware = errorHandler({
      format: (error) => Object.freeze({ message: error.message, nested: shared }),
      logErrors: false,
    });

    await middleware(ctx, () => {
      throw new HttpError(502, CONNECTION_URL);
    });

    expect(responseSnapshot().status).toBe(502);
    expectMasked(responseText(responseSnapshot().body));
    expect(shared.connection).toBe(CONNECTION_URL);
  });

  // Review of the served-body fix: a walk over plain objects missed values that
  // JSON.stringify serializes through toJSON or as an instance's own fields.
  class Connection {
    constructor(readonly dsn: string) {}
  }
  for (const [label, value] of [
    ['a URL', new URL(CONNECTION_URL)],
    ['a class instance', new Connection(CONNECTION_URL)],
    ['an object with toJSON', { toJSON: () => CONNECTION_URL }],
    ['a String object', new String(CONNECTION_URL)],
    ['a toJSON returning a String object', { toJSON: () => new String(CONNECTION_URL) }],
    ['an object key', { [CONNECTION_URL]: 1 }],
  ] as const) {
    it(`masks ${label} in details`, async () => {
      const { ctx, responseSnapshot } = createFakeContext();
      await errorHandler({ logErrors: false })(ctx, () => {
        throw new HttpError(409, 'conflict', { connection: value });
      });
      expectMasked(responseText(responseSnapshot().body));
    });
  }

  it('masks the instance composed by a responder without a full request context', () => {
    const { response, snapshot } = createFakeResponse();
    const responder = createErrorResponder(selectFormatter('rfc9457'), 'application/problem+json');

    responder.respond(
      { response, state: new Map(), request: { path: `/${CONNECTION_URL}` } },
      { status: 400, title: 'Bad Request', detail: CONNECTION_URL },
    );

    const text = responseText(snapshot().body);
    expectMasked(text);
    expect((JSON.parse(text) as Record<string, unknown>).instance).toBe(`/${MASKED_URL}`);
  });

  it('leaves a respond hook result application-owned', async () => {
    const { ctx, responseSnapshot } = createFakeContext();
    const middleware = errorHandler({
      respond: (error, context) => context.response.status(error.statusCode).text(error.message),
      logErrors: false,
    });

    await middleware(ctx, () => {
      throw new HttpError(502, CONNECTION_URL);
    });

    expect(responseSnapshot().status).toBe(502);
    expect(responseText(responseSnapshot().body)).toBe(CONNECTION_URL);
  });
});
