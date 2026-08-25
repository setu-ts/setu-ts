/**
 * Unit test: the responder a `errorHandler` installs answers a short-circuit
 * site's 4xx in the configured format WITHOUT masking it (plan §3.2).
 *
 * `maskInternalErrors` (default `true`) rewrites a caught non-`HttpError` that
 * resolves to status >= 500 into `Internal Server Error`. A responder-produced
 * 4xx must survive that: it carries a real `statusCode`, so it is neither
 * masked nor collapsed. This test drives a real `errorHandler` and a
 * short-circuiting site through a real kernel app, asserting the 400 is not
 * masked, that the content type follows the format, and that the site's
 * disclosure (`detail`) is kept verbatim (M70f F1) in BOTH formats.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { respondWithError } from '@setu-ts/common';
import type { ErrorResponderTarget, IRequestContext, IResponse } from '@setu-ts/common';

import { errorHandler } from '../../src/middleware/error-handler.ts';
import { createErrorResponder } from '../../src/middleware/error-responder-impl.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
import type { ErrorHandlerFormatter } from '../../src/formatters/error-formatter.ts';

/** A minimal `IResponse` that records the status, headers, and body. */
function fakeResponse(): { response: IResponse; record: { status?: number; body?: Uint8Array } } {
  const record: {
    status?: number;
    headers: Map<string, string>;
    body?: Uint8Array;
  } = { headers: new Map() };
  const self: IResponse = {
    status(code: number) {
      record.status = code;
      return self;
    },
    header(name: string, value: string) {
      record.headers.set(name, value);
      return self;
    },
    appendHeader(name: string, value: string) {
      record.headers.set(name, value);
      return self;
    },
    json<T>(body: T) {
      record.body = new TextEncoder().encode(JSON.stringify(body));
      return { __handlerResult: true };
    },
    text(body: string) {
      record.body = new TextEncoder().encode(body);
      return { __handlerResult: true };
    },
    html(body: string) {
      record.body = new TextEncoder().encode(body);
      // Mirrors the kernel builder, which sets this header.
      record.headers.set('content-type', 'text/html; charset=utf-8');
      return { __handlerResult: true };
    },
    send(body?: Uint8Array) {
      if (body !== undefined) {
        record.body = body;
      }
      return { __handlerResult: true };
    },
    redirect(url: string, status?: number) {
      record.headers.set('location', url);
      if (status !== undefined) {
        record.status = status;
      }
      return { __handlerResult: true };
    },
    stream(_body: ReadableStream<Uint8Array>) {
      return { __handlerResult: true };
    },
    snapshot() {
      return {
        streaming: false,
        status: record.status ?? 200,
        headers: new Headers(record.headers),
        body: record.body ?? null,
      };
    },
  };
  return { response: self, record };
}

/** Decodes the recorded response body to a JSON object. */
function decoded(record: { body?: Uint8Array }): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(record.body ?? new Uint8Array())) as Record<
    string,
    unknown
  >;
}

/**
 * Builds a started app with `errorHandler` (masking on) and a short-circuiting
 * site at `/short` that writes a 400 through the responder and never calls
 * `next()`.
 */
async function appWith(format: 'default' | 'rfc9457'): Promise<IKernelApplication> {
  const app = await createTestApp({ plugins: [RuntimePlugin()], autoStart: false });
  app.middleware.add(errorHandler({ format, maskInternalErrors: true, logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.middleware.add(
    async (ctx: IRequestContext, next: () => Promise<void>) => {
      if (ctx.request.path === '/short') {
        // The site's (non-)disclosure decision: a 400 with a disclosure.
        respondWithError(ctx, {
          status: 400,
          title: 'Bad Request',
          detail: 'the site disclosure',
        });
        return;
      }
      await next();
    },
    { priority: 100, name: 'short-circuit' },
  );
  app.router.get('/short', (ctx) => ctx.response.text('ok'));
  await app.start();
  return app;
}

describe('the installed responder does not mask a short-circuit 4xx', () => {
  it('answers a 400 (not a masked 500) under rfc9457 with problem+json', async () => {
    const app = await appWith('rfc9457');
    try {
      const res = await app.fetch(new Request('http://test.local/short'));
      // Not masked: a 4xx keeps its status and title, not `Internal Server Error`.
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.title).toBe('Bad Request');
      expect(body.status).toBe(400);
      // The site's disclosure is kept verbatim (F1).
      expect(body.detail).toBe('the site disclosure');
    } finally {
      await app.stop();
    }
  });

  it('answers a 400 (not a masked 500) under default with application/json', async () => {
    const app = await appWith('default');
    try {
      const res = await app.fetch(new Request('http://test.local/short'));
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toBe('Bad Request');
      // The site's disclosure is kept verbatim in the default format too (F1).
      expect(body.details).toEqual({ detail: 'the site disclosure' });
    } finally {
      await app.stop();
    }
  });
});

describe('the responder passes an honest context to the formatter (M70f round 2, finding 2)', () => {
  it('passes undefined to a custom formatter at a pre-pipeline site (no full context)', () => {
    // The kernel's pre-pipeline sites hand the responder a bare target of just
    // `state`, `response`, and an optional safe `request` path — no request
    // context exists yet. The formatter's `ctx` parameter must therefore be
    // `undefined` (the value its optional signature already declares), NOT a
    // partial object cast to `IRequestContext` whose `services`/`id`/`params`
    // do not exist. A custom formatter reading a documented member must not
    // throw.
    let observed: unknown = 'sentinel';
    const custom: ErrorHandlerFormatter = (error, ctx) => {
      observed = ctx;
      return { marker: 'custom', detail: error.message };
    };
    const responder = createErrorResponder(custom, 'application/json; charset=utf-8');
    const { response, record } = fakeResponse();
    const target: ErrorResponderTarget = {
      state: new Map(),
      response,
      request: { path: '/drain' },
    };
    responder.respond(target, { status: 503, title: 'Service Unavailable' });

    expect(observed).toBeUndefined();
    expect(record.status).toBe(503);
    const body = decoded(record);
    expect(body.marker).toBe('custom');
    expect(body.detail).toBe('Service Unavailable');
  });

  it('lets a custom formatter read a documented context member at a pre-pipeline site without throwing', () => {
    // The regression the round-2 review flagged: a formatter that reads a
    // documented context member that is absent on the pre-pipeline partial
    // (e.g. `ctx.request.path`) threw `TypeError: Cannot read properties of
    // undefined` because the responder cast the bare target to
    // `IRequestContext`. Now `ctx` is `undefined`, so the read short-circuits
    // and the configured 503 stands. This test FAILS without the fix: the
    // pre-fix partial has no `request` member, so `ctx.request.path` throws.
    let pathSeen: string | undefined = 'sentinel';
    const custom: ErrorHandlerFormatter = (error, ctx) => {
      // `ctx?.request.path` is `undefined` when `ctx` is `undefined` (the
      // post-fix value) but THROWS when `ctx` is the pre-fix partial, which
      // has no `request` member.
      pathSeen = ctx?.request.path;
      return { detail: error.message, path: pathSeen };
    };
    const responder = createErrorResponder(custom, 'application/json; charset=utf-8');
    const { response, record } = fakeResponse();
    const target: ErrorResponderTarget = { state: new Map(), response };
    responder.respond(target, { status: 503, title: 'Service Unavailable' });

    expect(pathSeen).toBeUndefined();
    expect(record.status).toBe(503);
    const body = decoded(record);
    expect(body.path).toBeUndefined();
  });

  it('passes the full context to the formatter at an in-pipeline site', () => {
    // An in-pipeline site passes the live `IRequestContext`, which the
    // formatter receives verbatim — so a formatter reading `ctx.request.path`
    // for the Problem Details `instance` still works, and the responder does
    // not double-supply `instance`.
    let observedPath: string | undefined = undefined;
    const custom: ErrorHandlerFormatter = (error, ctx) => {
      observedPath = ctx?.request.path;
      return { detail: error.message };
    };
    const responder = createErrorResponder(custom, 'application/json; charset=utf-8');
    const { response, record } = fakeResponse();
    const fullCtx: IRequestContext = {
      id: 'req-1',
      request: {
        method: 'GET',
        url: 'http://test.local/short',
        path: '/short',
        headers: new Headers(),
        json<T = unknown>(): Promise<T> {
          return Promise.resolve({} as T);
        },
        text: () => Promise.resolve(''),
        bytes: () => Promise.resolve(new Uint8Array()),
      },
      response,
      services: {
        get: () => {
          throw new Error('not needed');
        },
        has: () => false,
        register: () => undefined,
        registerFactory: () => undefined,
        getAll: () => [],
        unregister: () => false,
      },
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: new AbortController().signal,
    };
    const target: ErrorResponderTarget = fullCtx;
    responder.respond(target, { status: 400, title: 'Bad Request' });

    expect(observedPath).toBe('/short');
    expect(record.status).toBe(400);
  });

  it('supplies the Problem Details instance from the safe path at a pre-pipeline site', () => {
    // A Problem Details formatter answers with an `instance` member derived
    // from the request path. At a pre-pipeline site there is no context, so
    // the responder supplies the safe path the kernel captured separately.
    const { response, record } = fakeResponse();
    const responder = createErrorResponder(
      rfc9457Formatter,
      'application/problem+json',
    );
    const target: ErrorResponderTarget = {
      state: new Map(),
      response,
      request: { path: '/drain' },
    };
    responder.respond(target, { status: 503, title: 'Service Unavailable' });

    const body = decoded(record);
    expect(body.type).toBe('about:blank');
    expect(body.status).toBe(503);
    expect(body.instance).toBe('/drain');
  });

  it('omits the Problem Details instance when the request path is unreadable', () => {
    // A malformed request URL carries no readable path, so the target has no
    // `request` field and the `instance` member is simply absent — the correct
    // RFC 9457 outcome for a request whose path cannot be known.
    const { response, record } = fakeResponse();
    const responder = createErrorResponder(
      rfc9457Formatter,
      'application/problem+json',
    );
    const target: ErrorResponderTarget = { state: new Map(), response };
    responder.respond(target, { status: 400, title: 'Bad Request' });

    const body = decoded(record);
    expect(body.status).toBe(400);
    expect(body.instance).toBeUndefined();
  });
});
