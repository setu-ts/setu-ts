/**
 * Integration test for the upload middleware's X8-1 fix: a downstream handler
 * failure is no longer reported as a malformed multipart body.
 *
 * The register's control: a handler that throws BEHIND the upload middleware
 * must produce the SAME response as the same handler WITHOUT it (the handler's
 * own 500, in the configured format), not a 400 "malformed body". A genuinely
 * malformed body (no boundary) still answers 400 and logs a warn.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import { createUploadMiddleware } from '../../src/index.ts';

/** A well-formed single-file multipart body. */
const BOUNDARY = '----setu-test-boundary';
const MULTIPART_BODY = `--${BOUNDARY}\r\n` +
  `Content-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
  `Content-Type: text/plain\r\n\r\n` +
  `hello\r\n` +
  `--${BOUNDARY}--\r\n`;

/** Builds a started app (with `errorHandler`) and a throwing `/upload` route. */
async function app(withUpload: boolean): Promise<IKernelApplication> {
  const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  if (withUpload) {
    app.middleware.add(createUploadMiddleware(), { priority: 100, name: 'upload' });
  }
  app.router.post('/upload', () => {
    throw new Error('handler exploded downstream');
  });
  await app.start();
  return app;
}

describe('upload middleware passes downstream errors through (X8-1)', () => {
  it('a throwing handler behind the middleware answers like the same handler without it', async () => {
    const withMw = await app(true);
    const withoutMw = await app(false);
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        body: MULTIPART_BODY,
      } as RequestInit;

      const behind = await withMw.fetch(new Request('http://test.local/upload', init));
      const direct = await withoutMw.fetch(new Request('http://test.local/upload', init));

      // The handler's own 500 — not a 400 malformed body.
      expect(behind.status).toBe(500);
      expect(direct.status).toBe(500);
      expect(behind.headers.get('content-type')).toBe('application/problem+json');
      expect(direct.headers.get('content-type')).toBe('application/problem+json');

      const behindBody = (await behind.json()) as Record<string, unknown>;
      const directBody = (await direct.json()) as Record<string, unknown>;
      // Identical shape and identical masked title (the message is not disclosed).
      expect(behindBody).toEqual(directBody);
      expect(behindBody.title).toBe('Internal Server Error');
      expect(behindBody.status).toBe(500);
    } finally {
      await withMw.stop();
      await withoutMw.stop();
    }
  });

  it('a genuinely malformed body still answers 400 (not the downstream 500)', async () => {
    const withMw = await app(true);
    try {
      // No boundary in the content type → the parser rejects it.
      const res = await withMw.fetch(
        new Request('http://test.local/upload', {
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data' },
          body: 'not a real multipart body',
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.title).toBe('Bad Request');
    } finally {
      await withMw.stop();
    }
  });
});
