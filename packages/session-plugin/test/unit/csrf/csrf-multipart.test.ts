/**
 * CSRF over `multipart/form-data` (M94b) — the hole the shared form accessor
 * closes. The verifier now reads BOTH form encodings through
 * `ctx.request.formData` (falling back to the same shared `parseFormBody`),
 * so a token can arrive in a multipart FIELD, while a token submitted as a
 * FILE part is refused: a client chooses whether a part carries a `filename`,
 * so a non-string value must never reach `timingSafeEqualStrings`.
 *
 * Urlencoded and header behaviour are pinned unchanged, and a non-form body
 * still produces the ordinary mismatch — never the accessor's `415`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, parseFormBody } from '@setu-ts/common';
import type { FormBody, IRequest, IRequestContext } from '@setu-ts/common';

import { deriveKeyRing } from '../../../src/codec/crypto.ts';
import { CSRF_SESSION_KEY, getCsrfToken } from '../../../src/csrf/token.ts';
import { verifyCsrfToken } from '../../../src/csrf/verify.ts';
import { CsrfTokenMismatchError } from '../../../src/errors.ts';
import { resolveSessionConfig } from '../../../src/options.ts';
import { SESSION_STATE_KEY, SessionService } from '../../../src/services/session-service.ts';
import type { MakeContextOptions, TestContext } from '../../fixtures/context.ts';
import { fakeRandomBytes, makeClock, makeContext } from '../../fixtures/context.ts';
import { createFakeRuntime } from '../../fixtures/runtime.ts';

const SECRET = 'c'.repeat(32);
const MULTIPART = 'multipart/form-data; boundary=fb94';
const FORM = 'application/x-www-form-urlencoded';

/** Builds a urlencoded-style multipart body; `filename` present means a file part. */
function multipartBody(
  fields: ReadonlyArray<{ name: string; value: string; filename?: string }>,
  boundary = 'fb94',
): string {
  const out: string[] = [];
  for (const field of fields) {
    out.push(`--${boundary}\r\n`);
    out.push(
      field.filename === undefined
        ? `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`
        : `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    );
    out.push(`${field.value}\r\n`);
  }
  out.push(`--${boundary}--\r\n`);
  return out.join('');
}

/** Builds a context with the session middleware's effect already applied. */
async function withSession(options: MakeContextOptions = {}) {
  const clock = makeClock();
  const service = new SessionService(
    resolveSessionConfig(),
    await deriveKeyRing(crypto.subtle, [SECRET], 'encrypt'),
    {
      subtle: crypto.subtle,
      randomBytes: fakeRandomBytes,
      now: clock.now,
      uuid: clock.uuid,
    },
  );

  const harness = makeContext(options);
  harness.registry.register(CAPABILITIES.SESSION, service);
  harness.registry.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);

  const session = await service.load(harness.ctx);
  harness.ctx.state.set(SESSION_STATE_KEY, session);

  return { ...harness, session, service };
}

/**
 * Wraps the fixture request so it CARRIES the optional accessor — the shape
 * the three real producers have. The fixture's own request (no accessor) is
 * the fallback arm, which the fallback tests below drive unchanged.
 */
function withFormAccessor(harness: TestContext): IRequestContext {
  const request: IRequest & { formData?: () => Promise<FormBody> } = harness.ctx.request;
  request.formData = async (): Promise<FormBody> =>
    parseFormBody(await request.bytes(), request.headers.get('content-type'));
  return harness.ctx;
}

/** A session that already carries a minted token, over the given body. */
async function sessionWithToken(body: string, contentType: string) {
  const harness = await withSession({
    method: 'POST',
    body,
    headers: { 'content-type': contentType },
  });
  const token = getCsrfToken(harness.ctx);
  harness.session.set(CSRF_SESSION_KEY, token);
  return { ...harness, token };
}

describe('verifyCsrfToken — multipart (M94b)', () => {
  it('accepts a token submitted in a multipart FIELD, through the accessor', async () => {
    const seeded = await sessionWithToken('', MULTIPART);
    const body = multipartBody([
      { name: '_csrf', value: seeded.token },
      { name: 'note', value: 'x' },
    ]);
    const fresh = await sessionWithToken(body, MULTIPART);
    const ctx = withFormAccessor(fresh);

    await expect(verifyCsrfToken(ctx)).resolves.toBeUndefined();
  });

  it('accepts a token submitted in a multipart FIELD, through the FALLBACK arm', async () => {
    const seeded = await sessionWithToken('', MULTIPART);
    const body = multipartBody([{ name: '_csrf', value: seeded.token }]);
    const fresh = await sessionWithToken(body, MULTIPART);
    // `fresh.ctx.request` carries no accessor — the out-of-repo shape.
    await expect(verifyCsrfToken(fresh.ctx)).resolves.toBeUndefined();
  });

  it('refuses a token submitted as a FILE part', async () => {
    const body = multipartBody([
      { name: '_csrf', value: 'PENDING', filename: 'token.txt' },
    ]);
    const harness = await sessionWithToken(body, MULTIPART);
    const ctx = withFormAccessor(harness);

    await expect(verifyCsrfToken(ctx)).rejects.toThrow(CsrfTokenMismatchError);
    await expect(verifyCsrfToken(ctx)).rejects.toThrow('carried no CSRF token');
  });

  it('still lets the configured header win, without parsing the body', async () => {
    const harness = await sessionWithToken('', MULTIPART);
    const ctx = withFormAccessor(harness);
    // No token in the body at all — the header carries it.
    const request = ctx.request as IRequest;
    request.headers.set('x-csrf-token', harness.token);

    await expect(verifyCsrfToken(ctx)).resolves.toBeUndefined();
  });

  it('keeps the urlencoded path byte-identical', async () => {
    const body = '_csrf=PENDING';
    const harness = await sessionWithToken(body, FORM);
    const fresh = await sessionWithToken(`_csrf=${encodeURIComponent(harness.token)}`, FORM);
    await expect(verifyCsrfToken(fresh.ctx)).resolves.toBeUndefined();

    const wrong = await sessionWithToken('_csrf=wrong', FORM);
    await expect(verifyCsrfToken(wrong.ctx)).rejects.toThrow(CsrfTokenMismatchError);
  });

  it('a JSON body still produces the ordinary mismatch, never the 415', async () => {
    const harness = await sessionWithToken('{"a":1}', 'application/json');
    const ctx = withFormAccessor(harness);

    await expect(verifyCsrfToken(ctx)).rejects.toThrow('carried no CSRF token');
  });
});
