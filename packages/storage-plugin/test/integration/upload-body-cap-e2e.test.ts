/**
 * V5-1 end to end — an upload past `maxBodyBytes` is answered `413`, not
 * `400 Failed to parse multipart body`.
 *
 * The unit suite beside this one drives `createUploadMiddleware` with a
 * fabricated body read, which proves the middleware's own branch and nothing
 * about the wiring the defect actually lived in. Three separate things have to
 * line up for a real request to be answered correctly — the runtime's cap
 * rejecting with a hinted error, the kernel routing that rejection into the
 * middleware's `catch`, and the middleware reading the hint — and any of them
 * can break with the unit test still green.
 *
 * Driven through `app.fetch` and NOT `app.inject`, and that is load-bearing:
 * the cap lives in the HTTP adapter's request mapping, which `inject` does not
 * go through — it builds its own `IRequest`, so an `inject`-based test would
 * never cap the body at all and would pass whatever the middleware did.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createUploadMiddleware, StoragePlugin } from '../../src/index.ts';

/** A cap small enough that one part can exceed it. */
const MAX_BODY_BYTES = 512;

const BOUNDARY = '----setuV51Boundary';

/** Builds a well-formed multipart body of roughly the requested size. */
function multipart(fileBytes: number): string {
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="file"; filename="payload.bin"',
    'Content-Type: application/octet-stream',
    '',
    'x'.repeat(fileBytes),
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');
}

async function withApp(
  run: (app: ReturnType<typeof createApplication>) => Promise<void>,
): Promise<void> {
  const app = createApplication({
    plugins: [RuntimePlugin({ maxBodyBytes: MAX_BODY_BYTES }), StoragePlugin()],
  });
  app.middleware.add(createUploadMiddleware({ maxSize: 10_000_000 }), {
    priority: 100,
    name: 'upload',
  });
  app.router.post('/upload', (ctx) => ctx.response.json({ ok: true }));
  // No port: `app.fetch` still goes through the adapter's request mapping — which
  // is where the cap lives — and binding a socket would need a `net` grant
  // this package deliberately scopes to its object-store endpoint.
  await app.start();
  try {
    await run(app);
  } finally {
    await app.stop();
  }
}

function post(body: string): Request {
  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  });
}

describe('upload body cap E2E (V5-1)', () => {
  it('answers 413 for an upload past the runtime cap', async () => {
    await withApp(async (app) => {
      const body = multipart(MAX_BODY_BYTES * 2);
      expect(body.length).toBeGreaterThan(MAX_BODY_BYTES);

      const res = await app.fetch(post(body));
      const problem = await res.json() as { detail?: string; error?: string };

      // Pre-fix this was 400 "Failed to parse multipart body".
      expect(res.status).toBe(413);
      const text = `${problem.detail ?? ''}${problem.error ?? ''}`;
      expect(text).not.toContain('multipart');
    });
  });

  it('still answers 400 when the PARSE fails, under the cap', async () => {
    // The discriminating half: the refusal path must not swallow the parse
    // path, or the fix trades one wrong status for another. A content-type
    // naming no boundary is the parser's own refusal — an unhinted throw,
    // reached only because the body was small enough to be read at all.
    await withApp(async (app) => {
      const res = await app.fetch(
        new Request('http://localhost/upload', {
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data' },
          body: multipart(32),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  it('still accepts an upload under the cap', async () => {
    // Vacuity guard: without this, a route that refused everything would
    // satisfy both assertions above.
    await withApp(async (app) => {
      const res = await app.fetch(post(multipart(32)));
      expect(res.status).toBe(200);
    });
  });
});
