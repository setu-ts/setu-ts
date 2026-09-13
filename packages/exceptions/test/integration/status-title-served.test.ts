/**
 * A status-hint-branded error's title must survive to the SERVED body, and the
 * two formats must agree about it.
 *
 * This is the test whose absence let the `415` ship wrong. `415` is the first
 * status the framework brands but never produces through a factory — M94b's
 * form accessor rejects a non-form body with a `415`-branded error — and
 * `STATUS_TITLES` had no row for it, so `statusTitle(415)` fell through to the
 * generic `'Error'`. Under `'rfc9457'` a client read `"title": "Error"`; under
 * `'default'` the SAME error read `"message": "Unsupported Media Type"`, because
 * the default formatter serves the brand's own title while the Problem Details
 * formatter derives one from the status.
 *
 * Every existing assertion of that title was against `httpStatusHintOf(err)`
 * — the brand on the error OBJECT. Nothing drove the error through
 * `errorHandler` and read what the client actually receives, which is the only
 * place the two formats can be seen to disagree.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { withHttpStatusHint } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import type { ErrorFormat } from '../../src/formatters/error-formatter.ts';

/** The brand a first-party refusal carries, reproduced verbatim. */
function brandedError(status: number, title: string, detail: string): Error {
  return withHttpStatusHint(new Error(detail), { status, title, detail });
}

/** Boots an app whose `/boom` throws one branded error. */
async function appThrowing(format: ErrorFormat, error: Error): Promise<IKernelApplication> {
  const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
  app.middleware.add(errorHandler({ format, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.router.get('/boom', () => {
    throw error;
  });
  await app.start();
  return app;
}

/** Drives `/boom` and returns the parsed body. */
async function served(app: IKernelApplication): Promise<Record<string, unknown>> {
  const response = await app.fetch(new Request('http://test.local/boom'));
  return await response.json() as Record<string, unknown>;
}

describe('a branded status reaches the client with its canonical title', () => {
  /**
   * Every status first-party code brands with `withHttpStatusHint`, paired with
   * the canonical reason phrase a client must read. Enumerated as DATA so a new
   * branded status is one row here rather than a fifth place to remember —
   * the repo's rule that a claimed SET belongs in the test, not in prose.
   */
  const BRANDED: readonly (readonly [number, string])[] = [
    [400, 'Bad Request'],
    [413, 'Payload Too Large'],
    [415, 'Unsupported Media Type'],
    [501, 'Not Implemented'],
    [503, 'Service Unavailable'],
    [504, 'Gateway Timeout'],
  ];

  for (const [status, canonical] of BRANDED) {
    it(`serves ${status} as "${canonical}" under rfc9457`, async () => {
      const app = await appThrowing('rfc9457', brandedError(status, canonical, 'why it failed'));
      try {
        const body = await served(app);
        expect(body.status).toBe(status);
        // The regression: this read `'Error'` for 415 before the STATUS_TITLES row.
        expect(body.title).toBe(canonical);
        expect(body.title).not.toBe('Error');
        expect(body.detail).toBe('why it failed');
      } finally {
        await app.stop();
      }
    });

    it(`serves ${status} as "${canonical}" under the default format too`, async () => {
      const app = await appThrowing('default', brandedError(status, canonical, 'why it failed'));
      try {
        const body = await served(app);
        expect(body.statusCode).toBe(status);
        // The default formatter serves the brand's own title as `message`, so
        // this half was already correct — asserting BOTH is what shows the two
        // formats agreeing rather than one of them happening to be right.
        expect(body.message).toBe(canonical);
        expect(body.details).toEqual({ detail: 'why it failed' });
      } finally {
        await app.stop();
      }
    });
  }
});
