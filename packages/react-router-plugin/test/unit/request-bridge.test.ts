/**
 * Tests for the request/response bridge.
 *
 * Verifies GET carries no body, POST forwards buffered bytes, and web
 * Response → IResponse write-back covers buffered, streaming, and Set-Cookie
 * branches.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HandlerResult, IRuntimeServices } from '@hono-enterprise/common';
import type { LoadContextFunction, SsrRequestHandler } from '../../src/interfaces/index.ts';
import { bridgeRequestToRR } from '../../src/handler/request-bridge.ts';

describe('request-bridge', () => {
  function makeRuntime(): IRuntimeServices {
    return {
      platform: () => 'deno' as const,
      version: () => '2',
      hostname: () => 'localhost',
      uuid: () => 'id',
      randomBytes: (_n: number) => new Uint8Array(_n),
      subtle: crypto.subtle,
      now: () => 0,
      hrtime: () => 0,
      setTimeout: () => 0 as never,
      clearTimeout: () => {},
      setInterval: () => 0 as never,
      clearInterval: () => {},
      env: {},
      exit: () => {
        throw new Error('exit');
      },
    };
  }

  // Build a minimal IRequestContext mock capturing response state.
  function buildCtx(overrides?: { method?: string; body?: Uint8Array }): {
    ctx: Parameters<typeof bridgeRequestToRR>[0];
    respState: {
      status: number;
      headers: Map<string, string>;
      setCookies: string[];
      streamed: boolean;
    };
  } {
    const controller = new AbortController();
    const respState = {
      status: 200,
      headers: new Map<string, string>(),
      setCookies: [] as string[],
      streamed: false,
    };

    const handlerResult: HandlerResult = {
      __handlerResult: true,
    } as HandlerResult;

    const method = overrides?.method ?? 'GET';

    return {
      ctx: {
        id: 'r1',
        request: {
          method: method as
            | 'GET'
            | 'POST'
            | 'PUT'
            | 'PATCH'
            | 'DELETE'
            | 'HEAD'
            | 'OPTIONS',
          url: 'http://localhost/',
          path: '/',
          headers: new Headers(),
          json: (): Promise<Record<string, unknown>> => Promise.resolve({}),
          text: (): Promise<string> => Promise.resolve(''),
          bytes: (): Promise<Uint8Array> => Promise.resolve(overrides?.body ?? new Uint8Array()),
        },
        response: {
          status(c: number) {
            respState.status = c;
            return this;
          },
          header(name: string, value: string) {
            if (name.toLowerCase() !== 'set-cookie') {
              respState.headers.set(name, value);
            }
            return this;
          },
          appendHeader(name: string, value: string) {
            if (name === 'Set-Cookie') respState.setCookies.push(value);
            return this;
          },
          send(_b?: Uint8Array | undefined) {
            return handlerResult;
          },
          stream(_s: ReadableStream) {
            respState.streamed = true;
            return handlerResult;
          },
          json(_b: unknown) {
            return handlerResult;
          },
          text(_b: string) {
            return handlerResult;
          },
          redirect(_u: string) {
            return handlerResult;
          },
          snapshot() {
            return { streaming: false, body: null };
          },
        } as never,
        services: {} as never,
        params: {},
        query: {},
        state: new Map(),
        startTime: 0,
        signal: controller.signal,
      } as never,
      respState,
    };
  }

  it('GET request builds a Request with NO body and does not throw', async () => {
    let receivedMethod = '';
    let hasBody = false;

    const handler: SsrRequestHandler = (_req) => {
      receivedMethod = _req.method;
      hasBody = _req.body !== null;
      return Promise.resolve(new Response('<html></html>'));
    };

    const { ctx } = buildCtx({ method: 'GET' });
    await bridgeRequestToRR(ctx, handler, undefined, makeRuntime());

    expect(receivedMethod).toBe('GET');
    expect(hasBody).toBe(false);
  });

  it('POST request forwards buffered body to the handler', async () => {
    const postBody = new TextEncoder().encode(JSON.stringify({ key: 'val' }));
    let receivedBody = '';

    const handler: SsrRequestHandler = async (_req) => {
      receivedBody = await _req.text();
      return new Response('ok');
    };

    const { ctx } = buildCtx({ method: 'POST', body: postBody });
    await bridgeRequestToRR(ctx, handler, undefined, makeRuntime());

    expect(receivedBody).toBe(JSON.stringify({ key: 'val' }));
  });

  it('buffered Response maps correctly (status captured)', async () => {
    const handler: SsrRequestHandler = () =>
      Promise.resolve(
        new Response('<html>SSR</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

    const { ctx, respState } = buildCtx({ method: 'GET' });
    await bridgeRequestToRR(ctx, handler, undefined, makeRuntime());

    expect(respState.status).toBe(200);
  });

  it('streaming Response sets streamed flag on ctx.response', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('streamed'));
        c.close();
      },
    });

    const handler: SsrRequestHandler = () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

    const { ctx, respState } = buildCtx({ method: 'GET' });
    await bridgeRequestToRR(ctx, handler, undefined, makeRuntime());

    expect(respState.streamed).toBe(true);
  });

  it('Set-Cookie headers are emitted via appendHeader', async () => {
    const handler: SsrRequestHandler = (_req) => {
      // handler receives request; we do not assert on it here
      const resp = new Response('<html>ok</html>');
      resp.headers.append('Set-Cookie', 'session=abc; HttpOnly');
      resp.headers.append('Set-Cookie', 'token=xyz; Secure');
      return Promise.resolve(resp);
    };

    const { ctx, respState } = buildCtx({ method: 'GET' });
    await bridgeRequestToRR(ctx, handler, undefined, makeRuntime());

    expect(respState.setCookies).toContain('session=abc; HttpOnly');
    expect(respState.setCookies).toContain('token=xyz; Secure');
  });

  it('built Request carries ctx.request.method/url/headers', async () => {
    let receivedMethod = '';
    let receivedUrl = '';
    let receivedContentType = '';

    const handler: SsrRequestHandler = (_req) => {
      receivedMethod = _req.method;
      receivedUrl = _req.url;
      receivedContentType = _req.headers.get('Content-Type') ?? '';
      return Promise.resolve(new Response('ok'));
    };

    const { ctx } = buildCtx({ method: 'POST' });
    ctx.request.headers.set('Content-Type', 'application/json');
    (ctx.request as { url: string }).url = 'http://localhost/foo?bar=1';

    await bridgeRequestToRR(ctx, handler, undefined, makeRuntime());

    expect(receivedMethod).toBe('POST');
    expect(receivedUrl).toBe('http://localhost/foo?bar=1');
    expect(receivedContentType).toBe('application/json');
  });

  it('custom LoadContextFunction is passed through', async () => {
    let capturedContext: unknown = null;

    const handler: SsrRequestHandler = (_req, ctx) => {
      capturedContext = ctx;
      return Promise.resolve(new Response('ok'));
    };

    const customLc: LoadContextFunction = (_c: unknown) => ({ custom: 'http://localhost/' });
    const { ctx } = buildCtx({ method: 'GET' });

    await bridgeRequestToRR(ctx, handler, customLc, makeRuntime());

    expect(capturedContext).toEqual({ custom: 'http://localhost/' });
  });
});
