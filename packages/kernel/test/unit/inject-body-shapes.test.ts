/**
 * The `inject()` body table (M95c §3.9).
 *
 * `inject()` used to JSON-stringify every non-string body, so a
 * `URLSearchParams` arrived as the two bytes `{}` and a `Uint8Array` as
 * `{"0":97,…}` — destroying the input while answering 200. Each row here
 * asserts the EXACT bytes `ctx.request.bytes()` yields and the content-type
 * default the shape carries, so the `{}`-for-everything outcome cannot return.
 *
 * The refusal rows drive the RUNTIME check the type-level union cannot
 * enforce: `InjectRequest.body` is reachable from JavaScript and from an
 * `unknown`-typed caller, so a `Date` and a class instance — each rejected by
 * the type (the `@ts-expect-error` directives below are satisfied, not unused)
 * — must still be refused by name at runtime instead of silently stringified.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import type { InjectRequest } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const encoder = new TextEncoder();

/** A minimal application whose echo route reports the bytes it received. */
async function buildApp() {
  const runtime: IPlugin = {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
    },
  };

  const app = createApplication({ plugins: [runtime] });

  app.router.post('/echo', async (ctx) => {
    const bytes = await ctx.request.bytes();
    return ctx.response.json({
      length: bytes.length,
      body: new TextDecoder().decode(bytes),
      contentType: ctx.request.headers.get('content-type'),
    });
  });

  // Plugins register during start(); without it the registry is empty and
  // `#handleRequest` cannot resolve the runtime. No port → no socket binds.
  await app.start();

  return app;
}

interface Echoed {
  readonly length: number;
  readonly body: string;
  readonly contentType: string | null;
}

/**
 * The happy-path table's body parameter is the PUBLISHED union itself, with no
 * cast — so narrowing `InjectRequest.body` is a compile error here rather than
 * a silently smaller surface. Before this was typed, dropping `ArrayBuffer` and
 * `Blob` from the union left `deno check` and the entire suite green: the
 * widening's REFUSALS were pinned (by the `@ts-expect-error` rows below) while
 * its ACCEPTANCES were pinned by nothing. Row 1 of this same milestone exists
 * because a type-level claim needs a type-level guard.
 */
type InjectBody = NonNullable<InjectRequest['body']>;

async function echo(body: InjectBody, headers?: Record<string, string>): Promise<Echoed> {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/echo',
    ...(headers === undefined ? {} : { headers }),
    body,
  });
  expect(res.statusCode).toBe(200);
  return res.json<Echoed>();
}

// Every arm of the published union, asserted at COMPILE time. A row deleted
// from `InjectRequest.body` fails `deno task check` on the matching line — the
// `echo()` calls below exercise the same arms at runtime, but a test helper can
// always be re-typed, so the union's shape is pinned here independently.
const _acceptsString: InjectBody = 'a=1';
const _acceptsBytes: InjectBody = new Uint8Array([1]);
const _acceptsArrayBuffer: InjectBody = new ArrayBuffer(1);
const _acceptsBlob: InjectBody = new Blob([new Uint8Array([1])]);
const _acceptsSearchParams: InjectBody = new URLSearchParams('a=1');
const _acceptsPlainObject: InjectBody = { a: 1 };
void [
  _acceptsString,
  _acceptsBytes,
  _acceptsArrayBuffer,
  _acceptsBlob,
  _acceptsSearchParams,
  _acceptsPlainObject,
];

describe('inject() carries each documented body shape', () => {
  it('carries a string verbatim and keeps the JSON content-type default', async () => {
    const echoed = await echo('a=1&b=2');
    expect(echoed.body).toBe('a=1&b=2');
    expect(echoed.length).toBe(7);
    expect(echoed.contentType).toBe('application/json');
  });

  it('serialises a plain object as JSON — unchanged', async () => {
    const echoed = await echo({ hello: 'world', n: 2 });
    expect(echoed.body).toBe('{"hello":"world","n":2}');
    expect(echoed.contentType).toBe('application/json');
  });

  it('serialises a URLSearchParams with its own toString() and defaults urlencoded', async () => {
    const echoed = await echo(new URLSearchParams([['a', '1'], ['b', '2']]));
    expect(echoed.body).toBe('a=1&b=2');
    expect(echoed.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('carries a Uint8Array verbatim with NO content-type default', async () => {
    const bytes = encoder.encode('hello-bytes');
    const echoed = await echo(bytes);
    expect(echoed.body).toBe('hello-bytes');
    expect(echoed.length).toBe(bytes.length);
    expect(echoed.contentType).toBe(null);
  });

  it('carries an ArrayBuffer verbatim with NO content-type default', async () => {
    const echoed = await echo(encoder.encode('ab-bytes').buffer);
    expect(echoed.body).toBe('ab-bytes');
    expect(echoed.contentType).toBe(null);
  });

  it('awaits a Blob to bytes with NO content-type default', async () => {
    const echoed = await echo(new Blob([encoder.encode('blob-bytes')]));
    expect(echoed.body).toBe('blob-bytes');
    expect(echoed.contentType).toBe(null);
  });

  it('lets an explicitly supplied content type win over every default', async () => {
    const echoed = await echo(encoder.encode('x'), {
      'content-type': 'multipart/form-data; boundary=m95c',
    });
    expect(echoed.body).toBe('x');
    expect(echoed.contentType).toBe('multipart/form-data; boundary=m95c');
  });
});

describe("inject() copies a byte body rather than aliasing the caller's", () => {
  it('does not let a handler that mutates bytes() corrupt the array it was passed', async () => {
    const app = await buildApp();
    const fixture = encoder.encode('abc');

    app.router.post('/mutate', async (ctx) => {
      const bytes = await ctx.request.bytes();
      bytes[0] = 0x5a;
      return ctx.response.json({ seen: new TextDecoder().decode(bytes) });
    });

    const first = await app.inject({ method: 'POST', url: '/mutate', body: fixture });
    expect(first.json<{ seen: string }>().seen).toBe('Zbc');
    // The caller's fixture is untouched, so reusing it in a second request
    // carries none of the first request's mutation.
    expect(new TextDecoder().decode(fixture)).toBe('abc');

    const second = await app.inject({ method: 'POST', url: '/mutate', body: fixture });
    expect(second.json<{ seen: string }>().seen).toBe('Zbc');
  });

  it('does not alias an ArrayBuffer body either — new Uint8Array(buffer) is a view', async () => {
    const app = await buildApp();
    const buffer = encoder.encode('abc').buffer;

    app.router.post('/mutate-ab', async (ctx) => {
      (await ctx.request.bytes())[0] = 0x5a;
      return ctx.response.json({ ok: true });
    });

    await app.inject({ method: 'POST', url: '/mutate-ab', body: buffer });
    expect(new TextDecoder().decode(new Uint8Array(buffer))).toBe('abc');
  });
});

describe('inject() refuses every shape outside the union — by name', () => {
  it('refuses a Date, which the old path silently stringified to "{}"', async () => {
    const app = await buildApp();
    await expect(app.inject({
      method: 'POST',
      url: '/echo',
      // @ts-expect-error M95c: the TYPE refuses a Date; this row drives the RUNTIME refusal a JavaScript caller reaches.
      body: new Date(),
    })).rejects.toThrow(/received Date/);
  });

  it('refuses a class instance, naming its class', async () => {
    class Widget {
      value = 1;
    }
    const app = await buildApp();
    await expect(app.inject({
      method: 'POST',
      url: '/echo',
      // @ts-expect-error M95c: the TYPE refuses a class instance; this row drives the RUNTIME refusal.
      body: new Widget(),
    })).rejects.toThrow(/received Widget/);
  });

  it('refuses an array, which the old path destroyed as a JSON object', async () => {
    const app = await buildApp();
    await expect(app.inject({
      method: 'POST',
      url: '/echo',
      // @ts-expect-error M95c: the TYPE refuses an array; this row drives the RUNTIME refusal.
      body: [1, 2, 3],
    })).rejects.toThrow(TypeError);
  });

  it('refuses a bare number, closing the silent JSON.stringify path for primitives', async () => {
    const app = await buildApp();
    await expect(app.inject({
      method: 'POST',
      url: '/echo',
      // @ts-expect-error M95c: a number was never a documented body; the old path stringified it anyway.
      body: 42,
    })).rejects.toThrow(/received number/);
  });
});
