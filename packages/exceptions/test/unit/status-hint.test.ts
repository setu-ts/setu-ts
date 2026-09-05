/**
 * `errorHandler`'s reader for the M89b HTTP status hint (X19-1).
 *
 * A package that may not import this one — `@setu-ts/database-plugin`, whose
 * query-shape refusals are caller errors — brands its error with an
 * `HttpStatusHint` and `errorHandler` answers the hinted status with the
 * hint's own caller-safe `detail`, instead of the masked `500` those refusals
 * used to produce.
 *
 * The masking assertions live in THIS file deliberately: the exemption and the
 * rule it carves out of are one condition, so widening the exemption fails a
 * test on the line below rather than in a file someone might not run.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { NextFunction } from '@setu-ts/common';
import {
  CAPABILITIES,
  type HttpStatusHint,
  respondWithError,
  withHttpStatusHint,
} from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import { badRequest } from '../../src/errors/exceptions.ts';
import { createFakeContext, FakeLogger } from '../fixtures/fake-runtime.ts';

/**
 * A diagnostic of the shape masking exists to stop reaching a caller: it
 * quotes a statement and a bound parameter value (X12-3). Every assertion
 * below that checks the body for `SECRET` is checking that the hint mechanism
 * did not become a new disclosure channel.
 */
const DIAGNOSTIC = "SELECT * FROM users WHERE ssn = $1 -- ['SECRET-123']";

/** The hint `database-plugin` brands its query-shape refusals with. */
const HINT: HttpStatusHint = {
  status: 501,
  title: 'Not Implemented',
  detail: "Query feature 'orderBy' is not supported by the 'dynamodb' database adapter.",
};

/** Decode the response body back to a parsed object. */
function parseBody(body: Uint8Array | string | null): Record<string, unknown> {
  return JSON.parse(bodyText(body)) as Record<string, unknown>;
}

/** Decode the exact serialized response body. */
function bodyText(body: Uint8Array | string | null): string {
  if (body === null) return '';
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

/** A `next()` that throws the given value synchronously. */
function nextThrows(error: unknown): NextFunction {
  return () => {
    throw error;
  };
}

/** A branded error carrying the alarming diagnostic as its message. */
function hintedError(): Error {
  return withHttpStatusHint(new Error(DIAGNOSTIC), HINT);
}

describe('errorHandler — HTTP status hint', () => {
  it('answers the hinted status with the hint detail, masking ON', async () => {
    // The default configuration: `maskInternalErrors` is on, and a hinted
    // `501` satisfies all three of its clauses (`!isHttpError`, `>= 500`), so
    // without the exemption this body would read `Internal Server Error` —
    // the exact symptom X19-1 records.
    const { ctx, responseSnapshot } = createFakeContext();

    await errorHandler()(ctx, nextThrows(hintedError()));

    const snapshot = responseSnapshot();
    expect(snapshot.status).toBe(501);
    const body = parseBody(snapshot.body);
    expect(body.statusCode).toBe(501);
    expect(body.message).toBe('Not Implemented');
    expect(body.details).toEqual({ detail: HINT.detail });
  });

  it('serves the hint detail and NEVER the error message', async () => {
    // The narrowness of the exemption is structural: what is served is a
    // sentence the brand site wrote, so there is no driver diagnostic in the
    // body for masking to have removed. A future reader that fell back to
    // `error.message` fails here.
    const { ctx, responseSnapshot } = createFakeContext();

    await errorHandler()(ctx, nextThrows(hintedError()));

    const serialized = JSON.stringify(parseBody(responseSnapshot().body));
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('SELECT');
  });

  it('carries the hint detail through the Problem Details formats', async () => {
    // The hint is built through the same constructor `respondWithError` uses,
    // so the disclosure reaches the `detail` MEMBER rather than being dropped
    // for the status title — which is what happens when only the `default`
    // format's `details.detail` channel is written.
    for (const format of ['rfc9457', 'rfc7807'] as const) {
      const { ctx, responseSnapshot } = createFakeContext();

      await errorHandler({ format })(ctx, nextThrows(hintedError()));

      const snapshot = responseSnapshot();
      expect(snapshot.status).toBe(501);
      expect(snapshot.headers.get('content-type')).toBe('application/problem+json');
      const body = parseBody(snapshot.body);
      expect(body.status).toBe(501);
      expect(body.title).toBe('Not Implemented');
      expect(body.detail).toBe(HINT.detail);
    }
  });

  it('logs the UNMASKED diagnostic while serving only the hint detail', async () => {
    // The operator keeps everything: the hint changes the response, never the
    // log. Losing this would trade one blind spot for another.
    const logger = new FakeLogger();
    const { ctx } = createFakeContext({
      services: new Map([[CAPABILITIES.LOGGER, logger]]),
    });

    await errorHandler()(ctx, nextThrows(hintedError()));

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.message).toBe(DIAGNOSTIC);
  });

  it('logs the status it actually SERVED, not the normalized 500', async () => {
    // An operator correlating a log line with a response would otherwise be
    // looking for a `500` no client ever saw.
    const logger = new FakeLogger();
    const { ctx } = createFakeContext({
      services: new Map([[CAPABILITIES.LOGGER, logger]]),
    });

    await errorHandler()(ctx, nextThrows(hintedError()));

    expect(logger.calls[0]?.meta?.statusCode).toBe(501);
  });

  it('omits the stack even when includeStackTrace is on', async () => {
    // A stack's first line is `<name>: <message>`, so attaching it would put
    // the diagnostic straight back into the body the hint just kept out — the
    // same reasoning that makes masking win over this option.
    const { ctx, responseSnapshot } = createFakeContext();

    await errorHandler({ includeStackTrace: true })(ctx, nextThrows(hintedError()));

    const body = parseBody(responseSnapshot().body);
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('still masks an UNHINTED internal error', async () => {
    // The negative control for the exemption above, in the same file: widen
    // the masking condition and this fails on the line below.
    const { ctx, responseSnapshot } = createFakeContext();

    await errorHandler()(ctx, nextThrows(new Error(DIAGNOSTIC)));

    const snapshot = responseSnapshot();
    expect(snapshot.status).toBe(500);
    const body = parseBody(snapshot.body);
    expect(body.message).toBe('Internal Server Error');
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('lets a deliberately thrown HttpError keep its own status', async () => {
    // A brand must not be able to override a status the developer stated. The
    // reader is consulted only for a non-`HttpError`, so an `HttpError` that
    // somehow carried a hint answers as itself.
    const { ctx, responseSnapshot } = createFakeContext();
    const error = withHttpStatusHint(badRequest('Invalid payload'), HINT);

    await errorHandler()(ctx, nextThrows(error));

    const snapshot = responseSnapshot();
    expect(snapshot.status).toBe(400);
    expect(parseBody(snapshot.body).message).toBe('Invalid payload');
  });

  it('ignores a hint whose brand value is malformed', async () => {
    // `httpStatusHintOf` rejects a foreign value under the global symbol, so
    // the error takes the ordinary masked path rather than a half-read hint.
    const { ctx, responseSnapshot } = createFakeContext();
    const error = new Error(DIAGNOSTIC);
    Object.defineProperty(error, Symbol.for('setu.http.status-hint'), {
      value: { status: 'not a number' },
      configurable: true,
    });

    await errorHandler()(ctx, nextThrows(error));

    expect(responseSnapshot().status).toBe(500);
  });

  it('answers identically to respondWithError given the same values', async () => {
    // One capability, one implementation. A hint IS an `ErrorResponseInit`,
    // and both entry points build their `HttpError` through the same
    // `buildErrorFromInit` — so a package that can reach `respondWithError`
    // (it holds a context) and one that can only brand its error (it does not)
    // produce the same response for the same decision.
    //
    // Hand-rolling the construction in `errorHandler` would diverge silently:
    // the `default` formatter reads `details.detail` while the Problem Details
    // formatters read a module-private symbol, so getting either half wrong
    // loses the disclosure in exactly one format.
    for (const format of ['default', 'rfc9457', 'rfc7807'] as const) {
      const { ctx: thrownCtx, responseSnapshot: thrownSnapshot } = createFakeContext();
      const { ctx: respondedCtx, responseSnapshot: respondedSnapshot } = createFakeContext();

      await errorHandler({ format })(thrownCtx, nextThrows(hintedError()));
      await errorHandler({ format })(respondedCtx, () => {
        respondWithError(respondedCtx, HINT);
        return Promise.resolve();
      });

      expect(thrownSnapshot().status, format).toBe(respondedSnapshot().status);
      expect(bodyText(thrownSnapshot().body), format).toBe(bodyText(respondedSnapshot().body));
      expect(thrownSnapshot().headers.get('content-type'), format).toBe(
        respondedSnapshot().headers.get('content-type'),
      );
    }
  });

  it('answers a hinted error identically with masking explicitly OFF', async () => {
    // The exemption does not depend on the option: a hinted response carries
    // the brand site's sentence either way, so the two configurations agree.
    const { ctx: onCtx, responseSnapshot: onSnapshot } = createFakeContext();
    const { ctx: offCtx, responseSnapshot: offSnapshot } = createFakeContext();

    await errorHandler({ maskInternalErrors: true })(onCtx, nextThrows(hintedError()));
    await errorHandler({ maskInternalErrors: false })(offCtx, nextThrows(hintedError()));

    expect(parseBody(onSnapshot().body)).toEqual(parseBody(offSnapshot().body));
    expect(onSnapshot().status).toBe(offSnapshot().status);
  });
});
