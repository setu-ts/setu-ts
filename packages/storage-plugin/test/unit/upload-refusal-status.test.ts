/**
 * V5-1 — an upload whose body was REFUSED is answered as the refusal, not as
 * a malformed multipart.
 *
 * Since M90a `ctx.request.bytes()` can reject rather than return:
 * `RuntimePlugin({ maxBodyBytes })` bounds it and rejects with a
 * `RequestBodyTooLargeError` branded with a `413` hint. The middleware's catch
 * answered a fixed `400 Failed to parse multipart body`, which names the wrong
 * cause — the body was never parsed — and the wrong remedy, since a client
 * told its multipart is malformed re-sends the same oversized upload.
 *
 * The catch's own comment cites X8-1, the fix that narrowed it to the parse.
 * This is the same shape one throw later.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRequestContext } from '@setu-ts/common';
import { withHttpStatusHint } from '@setu-ts/common';
import { createUploadMiddleware } from '../../src/middleware/upload-middleware.ts';

/** What the middleware answered. */
interface Answer {
  status: number;
  title: string;
  detail: string;
}

/**
 * A context whose body read rejects with the given value, recording whatever
 * the middleware answers and whether the handler downstream ever ran.
 */
function makeCtx(rejectWith: unknown): { ctx: IRequestContext; answers: Answer[] } {
  const answers: Answer[] = [];
  let status = 200;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      const problem = payload as { title?: string; error?: string; detail?: string };
      answers.push({
        status,
        title: problem.title ?? problem.error ?? '',
        detail: problem.detail ?? '',
      });
      return {} as never;
    },
    send: () => ({}) as never,
    header() {
      return this;
    },
  };
  const ctx = {
    id: 'v5-1',
    request: {
      method: 'POST',
      url: 'http://localhost/upload',
      path: '/upload',
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=b' }),
      bytes: () => Promise.reject(rejectWith),
    },
    response,
    state: new Map<string, unknown>(),
    services: { has: () => false, get: () => undefined },
    logger: undefined,
  } as unknown as IRequestContext;
  return { ctx, answers };
}

async function run(rejectWith: unknown): Promise<{ answer?: Answer; handlerRan: boolean }> {
  const { ctx, answers } = makeCtx(rejectWith);
  let handlerRan = false;
  await createUploadMiddleware({ fieldname: 'file' })(ctx, () => {
    handlerRan = true;
    return Promise.resolve();
  });
  return { ...(answers[0] === undefined ? {} : { answer: answers[0] }), handlerRan };
}

describe('upload body refusal status (V5-1)', () => {
  it('answers the refusal 413, not 400 Failed to parse multipart body', async () => {
    const refusal = withHttpStatusHint(
      new Error('Request body exceeds the configured maximum of 1024 bytes (internal)'),
      {
        status: 413,
        title: 'Payload Too Large',
        detail: 'Request body exceeds the configured maximum of 1024 bytes.',
      },
    );

    const { answer, handlerRan } = await run(refusal);

    expect(answer?.status).toBe(413);
    expect(answer?.title).toBe('Payload Too Large');
    expect(answer?.detail).toBe('Request body exceeds the configured maximum of 1024 bytes.');
    expect(answer?.detail).not.toContain('multipart');
    // The refusal still short-circuits: the handler must not see a request
    // whose body was never read.
    expect(handlerRan).toBe(false);
  });

  it('serves the hint detail, never the error message', async () => {
    const refusal = withHttpStatusHint(new Error('operator-only diagnostic'), {
      status: 413,
      title: 'Payload Too Large',
      detail: 'Too large.',
    });

    const { answer } = await run(refusal);

    expect(answer?.detail).toBe('Too large.');
    expect(JSON.stringify(answer)).not.toContain('operator-only diagnostic');
  });

  it('still answers 400 for a genuinely malformed body', async () => {
    // The discriminating half: the refusal path must not swallow the parse
    // path, or the fix would trade one wrong status for another.
    const { answer, handlerRan } = await run(new Error('unexpected end of multipart body'));

    expect(answer?.status).toBe(400);
    expect(answer?.detail).toBe('Failed to parse multipart body');
    expect(handlerRan).toBe(false);
  });
});
