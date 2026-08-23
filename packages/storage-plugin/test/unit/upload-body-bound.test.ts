/**
 * X8-3 — what an upload's `maxSize` actually bounds.
 *
 * The register's finding was that `maxSize` bounds what is ACCEPTED, not what
 * is parsed, and that the guard meant to bound the latter was inverted:
 * `Math.max(maxSize * 2, 50 MB)` under a comment reading "cap at 50 MB" made
 * 50 MB a FLOOR, so any `maxSize` above 25 MB raised the bound without limit
 * and a 100 MB per-file limit delivered a 60 MB body to the handler.
 *
 * The matrix below is the register's own probe table. Each row asserts BOTH the
 * status and the refusal's title, because the title is the only externally
 * visible signal of WHICH guard fired — a test asserting only "an oversized
 * upload is refused" passes against either guard, which is precisely why no
 * gate caught this.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRequestContext } from '@setu-ts/common';
import {
  createUploadMiddleware,
  resolveMaxBodyBytes,
} from '../../src/middleware/upload-middleware.ts';

const MB = 1024 * 1024;

/** What a refusal answered, so a test can name the guard that produced it. */
interface Refusal {
  status: number;
  title: string;
}

/**
 * A context that records the status and Problem Details title of any refusal,
 * and whether the handler downstream ever ran.
 */
function makeCtx(body: Uint8Array, contentLength?: number): {
  ctx: IRequestContext;
  refusals: Refusal[];
} {
  const refusals: Refusal[] = [];
  let status = 200;
  const headers = new Headers({ 'content-type': 'multipart/form-data; boundary=b' });
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength));
  }
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      const problem = payload as { title?: string; error?: string };
      refusals.push({ status, title: problem.title ?? problem.error ?? '' });
      return {} as never;
    },
    send: () => ({}) as never,
    header() {
      return this;
    },
  };
  const ctx = {
    id: 'x8-3',
    request: {
      method: 'POST',
      url: 'http://localhost/upload',
      path: '/upload',
      headers,
      bytes: () => Promise.resolve(body),
    },
    response,
    state: new Map<string, unknown>(),
    services: { has: () => false, get: () => undefined },
  } as unknown as IRequestContext;
  return { ctx, refusals };
}

/** Builds a valid single-file multipart body of the requested payload size. */
function multipartBody(fileBytes: number): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    '--b\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = encoder.encode('\r\n--b--\r\n');
  const body = new Uint8Array(head.length + fileBytes + tail.length);
  body.set(head, 0);
  body.fill(65, head.length, head.length + fileBytes);
  body.set(tail, head.length + fileBytes);
  return body;
}

/** Runs the middleware and reports the refusal plus whether the handler ran. */
async function run(
  options: Parameters<typeof createUploadMiddleware>[0],
  body: Uint8Array,
  contentLength?: number,
): Promise<{ refusal?: Refusal; handlerRan: boolean }> {
  const { ctx, refusals } = makeCtx(body, contentLength);
  let handlerRan = false;
  await createUploadMiddleware(options)(ctx, () => {
    handlerRan = true;
    return Promise.resolve();
  });
  return { ...(refusals[0] === undefined ? {} : { refusal: refusals[0] }), handlerRan };
}

describe('resolveMaxBodyBytes — a cap, not a floor (X8-3)', () => {
  it('should follow maxSize upward while it is below the ceiling', () => {
    // 1 KB per file no longer authorizes parsing 50 MB.
    expect(resolveMaxBodyBytes(1024)).toBe(1024 * 2 + 8 * 1024);
  });

  it('should stop at the ceiling instead of raising the bound without limit', () => {
    // The inverted expression returned 200 MB here; the documented cap is 50 MB.
    expect(resolveMaxBodyBytes(100 * MB)).toBe(50 * MB);
  });

  it('should honour a configured ceiling below the default', () => {
    expect(resolveMaxBodyBytes(100 * MB, 4 * MB)).toBe(4 * MB);
  });

  it('should honour a configured ceiling above the default', () => {
    // 100 MB per file wants 200 MB + framing; the raised ceiling still caps it.
    expect(resolveMaxBodyBytes(100 * MB, 200 * MB)).toBe(200 * MB);
  });
});

describe('createUploadMiddleware — the register probe matrix (X8-3)', () => {
  it('row 1: a 1 KB limit refuses a large body BEFORE parsing it', async () => {
    // The finding: this used to reach `parseMultipart` and be caught only by
    // the per-file check afterwards, so a 1 KB limit multipart-parsed 40 MB
    // first. `Request entity too large` is the pre-parse guard;
    // `File too large` is the post-parse one.
    const { refusal, handlerRan } = await run({ maxSize: 1024 }, multipartBody(2 * MB));

    expect(handlerRan).toBe(false);
    expect(refusal).toEqual({ status: 413, title: 'Request entity too large' });
  });

  it('row 2: a 100 MB limit no longer lets an oversized body through', async () => {
    // The bound is now the 50 MB ceiling rather than 200 MB, so a body above it
    // is refused instead of being handed to the handler.
    const { refusal, handlerRan } = await run(
      { maxSize: 100 * MB },
      new Uint8Array(0),
      60 * MB,
    );

    expect(handlerRan).toBe(false);
    expect(refusal).toEqual({ status: 413, title: 'Request entity too large' });
  });

  it('row 3 (control): a body within the bound but a file over maxSize hits the FILE guard', async () => {
    // The control that makes the guard labels meaningful: with `maxSize` at
    // 1.5 MB the bound is ~3 MB, so a 2 MB body gets PAST the pre-parse guard
    // and is refused by the per-file check instead. Without this row a test
    // asserting only "oversized uploads are refused" could not tell the two
    // guards apart — which is the whole finding.
    const { refusal, handlerRan } = await run(
      { maxSize: Math.floor(1.5 * MB) },
      multipartBody(2 * MB),
    );

    expect(handlerRan).toBe(false);
    expect(refusal).toEqual({ status: 413, title: 'File too large' });
  });

  it('should accept a payload within both bounds and run the handler', async () => {
    const { refusal, handlerRan } = await run({ maxSize: 4 * MB }, multipartBody(1024));

    expect(refusal).toBeUndefined();
    expect(handlerRan).toBe(true);
  });

  it('should keep a disallowed MIME type a 400, not a 413', async () => {
    // Size and unacceptability are different faults and must stay
    // distinguishable on the wire.
    const { refusal } = await run(
      { maxSize: 4 * MB, allowedMimeTypes: ['image/png'] },
      multipartBody(64),
    );

    expect(refusal).toEqual({ status: 400, title: 'Invalid MIME type' });
  });

  it('should keep too-many-files a 400, not a 413', async () => {
    const encoder = new TextEncoder();
    const two = encoder.encode(
      '--b\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nA\r\n' +
        '--b\r\nContent-Disposition: form-data; name="file"; filename="b"\r\n\r\nB\r\n--b--\r\n',
    );
    const { refusal } = await run({ maxSize: 4 * MB, maxFiles: 1 }, two);

    expect(refusal).toEqual({ status: 400, title: 'Too many files' });
  });
});

describe('createUploadMiddleware — a limit that cannot bound anything (review)', () => {
  /**
   * `NaN` propagates through `Math.min`, and every later `>` comparison against
   * `NaN` is `false` — so one `maxSize: Number(env.MAX)` with an unset variable
   * would silently disable BOTH the body bound and the per-file limit, leaving
   * the middleware parsing an unbounded multipart body. It fails at route setup
   * instead, naming the option.
   */
  it('should refuse NaN rather than silently removing every limit', () => {
    expect(() => resolveMaxBodyBytes(Number('not a number'))).toThrow(RangeError);
    expect(() => resolveMaxBodyBytes(1024, Number.NaN)).toThrow(/maxBodyBytes/);
  });

  it('should refuse a negative or infinite limit', () => {
    expect(() => resolveMaxBodyBytes(-1)).toThrow(/maxSize/);
    expect(() => resolveMaxBodyBytes(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => resolveMaxBodyBytes(1024, -5)).toThrow(/maxBodyBytes/);
  });

  it('should accept zero, which is a real choice — refuse every upload', () => {
    // Distinct from the invalid values above: `0` bounds, it just bounds at
    // nothing, and refusing it would remove a legitimate configuration.
    expect(resolveMaxBodyBytes(0, 0)).toBe(0);
  });

  it('should surface the refusal when the middleware is constructed', () => {
    expect(() => createUploadMiddleware({ maxSize: Number.NaN })).toThrow(RangeError);
  });
});
