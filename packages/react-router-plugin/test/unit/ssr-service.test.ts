/**
 * Tests for SsrService — render() delegates to bridge, write-back, custom loadContext.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HandlerResult,
  IFileSystem,
  IRuntimeServices,
  ISsrService,
} from '@hono-enterprise/common';
import type { LoadContextFunction, SsrRequestHandler } from '../../src/interfaces/index.ts';
import { SsrService } from '../../src/services/ssr-service.ts';
import { CAPABILITIES } from '@hono-enterprise/common';

describe('ssr-service', () => {
  function makeFakeRuntime(): IRuntimeServices {
    return {
      platform: () => 'deno' as const,
      version: () => '2.0',
      hostname: () => 'localhost',
      uuid: () => 'id',
      randomBytes: (n: number) => new Uint8Array(n),
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
      fs: undefined as unknown as IFileSystem,
    } as unknown as IRuntimeServices;
  }

  function buildMockCtx() {
    const controller = new AbortController();
    let body: Uint8Array | undefined;
    let stream: ReadableStream<Uint8Array> | undefined;
    const handlerResult = { __handlerResult: true } as HandlerResult;

    const mockResponse: Record<string, unknown> = {
      status(_c: number) {
        return this;
      },
      header(_name: string, _value: string) {
        return this;
      },
      appendHeader(_name: string, _value: string) {
        return this;
      },
      send(b?: Uint8Array) {
        body = b;
        return handlerResult;
      },
      json<T>(_body: T) {
        return handlerResult;
      },
      text(_body: string) {
        return handlerResult;
      },
      redirect(_url: string) {
        return handlerResult;
      },
      stream(s: ReadableStream<Uint8Array>) {
        stream = s;
        return handlerResult;
      },
      snapshot() {
        return { streaming: !!stream, body: body ?? null };
      },
    };

    const mockRequest: Record<string, unknown> = {
      method: 'GET' as const,
      url: 'http://localhost/',
      path: '/',
      headers: new Headers(),
      get user() {
        return undefined;
      },
      set user(_v) {
        // noop
      },
      json: () => ({}),
      text: () => '',
      bytes: () => new Uint8Array(),
      signal: controller.signal,
    };

    return {
      id: 'r1',
      request: mockRequest,
      response: mockResponse,
      services: {} as never,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: controller.signal,
    } as never;
  }

  it('render composes bridge → handler → write-back and returns HandlerResult', async () => {
    const fakeResponse = new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    // deno-lint-ignore require-await
    const fakeHandler: SsrRequestHandler = async () => fakeResponse;
    const service = new SsrService(fakeHandler, undefined, makeFakeRuntime());
    const ctx = buildMockCtx();

    const result = await service.render(ctx);

    expect(result).toEqual({ __handlerResult: true });
  });

  it('custom getLoadContext is passed through to the bridge', async () => {
    const loadCtx: LoadContextFunction = (_c: unknown) => ({ custom: 'http://localhost/' });
    let capturedContext: unknown = null;

    // deno-lint-ignore require-await
    const fakeHandler: SsrRequestHandler = async (_req: Request, ctx: unknown) => {
      capturedContext = ctx;
      return new Response('ok');
    };

    const service = new SsrService(fakeHandler, loadCtx, makeFakeRuntime());
    const mockCtx = buildMockCtx();

    await service.render(mockCtx);

    expect(capturedContext).toEqual({ custom: 'http://localhost/' });
  });

  it('service is the value registered under CAPABILITIES.SSR (structural check)', () => {
    // Verify the interface matches what CAPABILITIES.SSR would resolve to.
    const service = new SsrService(
      // deno-lint-ignore require-await
      async () => new Response('ok'),
      undefined,
      makeFakeRuntime(),
    );

    expect(typeof service.render).toBe('function');
    expect(CAPABILITIES.SSR).toBe('ssr');
    // Structural compatibility with ISsrService
    void (service as ISsrService);
  });
});
