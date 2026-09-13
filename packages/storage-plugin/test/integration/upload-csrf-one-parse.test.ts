/**
 * M94b e2e: one multipart POST, two first-party consumers.
 *
 * `csrfFormMiddleware` runs globally at priority 275, AHEAD of the route's
 * upload middleware. With the shared accessor, both read the SAME `FormBody`:
 * a token in a multipart FIELD now verifies (before this milestone the
 * request could only `403`), and the file is still delivered. The one-parse
 * contract is asserted as its one observable consequence — the reference a
 * mid-pipeline middleware stashes and the reference the route handler reads
 * are the SAME object. Counting `bytes()` calls would prove nothing: that
 * read is already memoized and returns once whether the form is parsed twice
 * or not.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, SessionPlugin } from '@setu-ts/session-plugin';
import { formEncodingOf } from '@setu-ts/common';
import type {
  HandlerResult,
  IPlugin,
  IPluginContext,
  IRequestContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import { createUploadMiddleware, getUploadedFile } from '../../src/index.ts';

const SECRET = 'c'.repeat(32);
const MULTIPART_CT = 'multipart/form-data; boundary=fb94';

/** Stashes the form reference mid-pipeline, after CSRF, before the upload. */
function formStashPlugin(): IPlugin {
  return {
    name: 'form-stash',
    version: '1.0.0',
    register(ctx: IPluginContext) {
      const stash: MiddlewareFunction = async (c: IRequestContext, next) => {
        // Only a form request is read — the same classifier guard the CSRF
        // verifier uses, so a bodyless GET never reaches the accessor's 415.
        if (formEncodingOf(c.request.headers.get('content-type')) !== undefined) {
          const read = c.request.formData;
          if (read !== undefined) {
            c.state.set('test:m94b-form', await read.call(c.request));
          }
        }
        await next();
      };
      // CSRF_FORM is 275; 300 runs after it and before the route middleware.
      ctx.middleware.add(stash, { name: 'form-stash', priority: 300 });
    },
  };
}

function boot(): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SECRET, csrf: {} }),
      formStashPlugin(),
    ],
  });
  app.router.get('/form', {
    handler: (c: IRequestContext): HandlerResult => c.response.json({ token: getCsrfToken(c) }),
  });
  app.router.post('/upload', {
    middleware: [createUploadMiddleware()],
    handler: async (c: IRequestContext): Promise<HandlerResult> => {
      const read = c.request.formData;
      const form = read === undefined ? undefined : await read.call(c.request);
      const stashed = c.state.get('test:m94b-form');
      const upload = getUploadedFile(c);
      return c.response.json({
        sameReference: stashed !== undefined && form !== undefined && Object.is(stashed, form),
        tokenInField: typeof form?.get('_csrf') === 'string',
        file: upload === undefined ? null : {
          name: upload.name,
          filename: upload.filename,
          size: upload.size,
          text: new TextDecoder().decode(upload.data),
        },
      });
    },
  });
  return app;
}

function multipartBody(fields: string[], boundary: string): string {
  return fields.map((field) => `--${boundary}\r\n${field}\r\n`).join('') +
    `--${boundary}--\r\n`;
}

describe('one multipart POST through CSRF and the upload middleware (M94b)', () => {
  it('a token in a multipart FIELD verifies, the file is delivered, and the form is parsed once', async () => {
    const app = boot();
    await app.start();
    try {
      // 1. Mint a session and its CSRF token over a cookie.
      const formRes = await app.fetch(new Request('http://localhost/form'));
      expect(formRes.status).toBe(200);
      const { token } = (await formRes.json()) as { token: string };
      const cookie = formRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      expect(token.length).toBeGreaterThan(0);

      // 2. The request that 403'd before this milestone: token in a FIELD.
      const body = multipartBody([
        `Content-Disposition: form-data; name="_csrf"\r\n\r\n${token}`,
        'Content-Disposition: form-data; name="file"; filename="doc.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\nUPLOAD',
      ], 'fb94');
      const res = await app.fetch(
        new Request('http://localhost/upload', {
          method: 'POST',
          headers: { 'content-type': MULTIPART_CT, cookie },
          body,
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sameReference: true,
        tokenInField: true,
        file: { name: 'file', filename: 'doc.txt', size: 6, text: 'UPLOAD' },
      });
    } finally {
      await app.stop();
    }
  });

  it('a multipart post with NO token is still refused 403 — acceptance did not loosen the check', async () => {
    const app = boot();
    await app.start();
    try {
      const res = await app.fetch(
        new Request('http://localhost/upload', {
          method: 'POST',
          headers: { 'content-type': MULTIPART_CT },
          body: multipartBody([
            'Content-Disposition: form-data; name="file"; filename="doc.txt"\r\n' +
            'Content-Type: text/plain\r\n\r\nUPLOAD',
          ], 'fb94'),
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      await app.stop();
    }
  });
});
