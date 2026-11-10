/**
 * M139b §3.1–§3.3: how the kernel writes an RPC reply and builds the RPC
 * request — streamed replies, streamed request bodies, the transport bit, and
 * trailers carried through the kernel's own stream re-wrapping.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { CAPABILITIES } from '@setu-ts/common';
import type {
  IGrpcService,
  IHttpAdapter,
  IPlugin,
  IRequest,
  IResponse,
  RpcCall,
  RpcReply,
  RpcTransport,
} from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import { DispatchedRequest } from '../../src/application/dispatched-request.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

const URL_BASE = 'http://localhost/pkg.Svc/Method';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Everything a fake gRPC service saw. */
interface Seen {
  transports: RpcTransport[];
  refuseTransports: (RpcTransport | undefined)[];
  /** Fetch requests handed to `handleRequest` (an implementor without `handleRpc`). */
  requests: Request[];
  /** Calls handed to `handleRpc`. */
  calls: RpcCall[];
}

/** A reply with the given body: text, bytes, a stream, or none. */
function reply(
  body: string | Uint8Array | ReadableStream<Uint8Array> | null,
  options: { streaming?: boolean; headers?: HeadersInit; trailers?: Promise<Headers> } = {},
): RpcReply {
  return {
    status: 200,
    headers: new Headers(options.headers),
    body: typeof body === 'string' ? encoder.encode(body) : body,
    streaming: options.streaming ?? body instanceof ReadableStream,
    ...(options.trailers === undefined ? {} : { trailers: options.trailers }),
  };
}

/** A structural `IGrpcService` double claiming every path. */
function grpcPlugin(service: Partial<IGrpcService>): IPlugin & { seen: Seen } {
  const seen: Seen = { transports: [], refuseTransports: [], requests: [], calls: [] };
  const full = {
    available: true,
    addService: () => undefined,
    claims: () => true,
    handleRequest: () => Promise.resolve(new Response(null)),
    ...service,
  } as IGrpcService;
  const recording: IGrpcService = {
    ...full,
    refuses: (request, transport) => {
      seen.refuseTransports.push(transport);
      return full.refuses?.(request, transport) ?? null;
    },
    handleRequest: (request) => {
      seen.requests.push(request);
      return full.handleRequest(request);
    },
    ...(full.handleRpc !== undefined
      ? {
          handleRpc: (call: RpcCall, transport: RpcTransport) => {
            seen.calls.push(call);
            seen.transports.push(transport);
            return full.handleRpc!(call, transport);
          },
        }
      : {}),
    ...(full.streamsRequest !== undefined ? { streamsRequest: full.streamsRequest } : {}),
  };
  return {
    name: 'fake-grpc',
    version: '1.0.0',
    provides: [CAPABILITIES.GRPC],
    register(ctx) {
      ctx.services.register(CAPABILITIES.GRPC, recording);
    },
    seen,
  };
}

/** An HTTP adapter double that only captures the kernel's handler. */
function capturingAdapter(): IPlugin & {
  handler: () => (request: IRequest) => IResponse | Promise<IResponse>;
} {
  let captured: ((request: IRequest) => IResponse | Promise<IResponse>) | undefined;
  const adapter: IHttpAdapter = {
    setHandler: (handler) => {
      captured = handler;
    },
    fetch: () => new Response(null, { status: 500 }),
    listen: () => Promise.reject(new Error('not listening')),
    close: () => Promise.resolve(),
  };
  return {
    name: 'capturing-adapter',
    version: '1.0.0',
    provides: [CAPABILITIES.HTTP_ADAPTER],
    register(ctx) {
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, adapter);
    },
    handler: () => {
      if (captured === undefined) throw new Error('handler not set');
      return captured;
    },
  };
}

/** A request an adapter mapped from an HTTP/2 connection that writes trailers. */
class TrailerCapableRequest extends DispatchedRequest {
  readonly responseTrailers = true;
}

/** A body stream the test feeds by hand, never closing unless told to. */
function manualStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

/** Rejects if `promise` has not settled within `ms` — a buffered stream never would. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

async function started(...plugins: IPlugin[]): Promise<ReturnType<typeof createApplication>> {
  const app = createApplication({ plugins: [runtimePlugin(), ...plugins] });
  await app.start();
  return app;
}

describe('M139b §3.1 — RPC replies', () => {
  it('a streaming reply reaches the client message by message (V12-39)', async () => {
    const body = manualStream();
    const grpc = grpcPlugin({
      handleRpc: () => Promise.resolve(reply(body.stream)),
    });
    const app = await started(grpc);
    body.push('first');
    // Buffered, `dispatch` would wait for a body that is never closed.
    const response = await within(app.dispatch!(new Request(URL_BASE, { method: 'POST' })));
    const reader = response.body!.getReader();
    expect(decoder.decode((await within(reader.read())).value)).toBe('first');
    body.push('second');
    expect(decoder.decode((await within(reader.read())).value)).toBe('second');
    body.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('a single response message is buffered, so inject() still reads it', async () => {
    const grpc = grpcPlugin({
      handleRpc: () => Promise.resolve(reply('unary', { headers: { 'x-a': '1' } })),
    });
    const app = await started(grpc);
    const response = await app.inject({ method: 'POST', url: '/pkg.Svc/Method' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('unary');
    expect(response.headers.get('x-a')).toBe('1');
  });

  it('an implementor without handleRpc keeps the buffered write it had', async () => {
    const grpc = grpcPlugin({
      handleRequest: () => Promise.resolve(new Response('legacy', { status: 201 })),
    });
    const app = await started(grpc);
    const response = await app.inject({ method: 'POST', url: '/pkg.Svc/Method' });
    expect(response.statusCode).toBe(201);
    expect(response.body).toBe('legacy');
    expect(grpc.seen.requests).toHaveLength(1);
  });

  it('a bodyless reply is written bodyless', async () => {
    const grpc = grpcPlugin({
      handleRpc: () => Promise.resolve(reply(null, { headers: { 'grpc-status': '5' } })),
    });
    const app = await started(grpc);
    const response = await app.dispatch!(new Request(URL_BASE, { method: 'POST' }));
    expect(response.headers.get('grpc-status')).toBe('5');
    expect(await response.text()).toBe('');
  });

  it('a reply header repeated by the service keeps every value', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const grpc = grpcPlugin({ handleRpc: () => Promise.resolve(reply('x', { headers })) });
    const app = await started(grpc);
    const response = await app.dispatch!(new Request(URL_BASE, { method: 'POST' }));
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('a header-only refusal is written bodyless, with every repeated header kept', async () => {
    const refusal = new Response(null, {
      status: 200,
      headers: [
        ['grpc-status', '12'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
    });
    const grpc = grpcPlugin({
      refuses: () => refusal,
      handleRpc: () => Promise.reject(new Error('must not dispatch')),
    });
    const app = await started(grpc);
    const response = await app.dispatch!(new Request(URL_BASE, { method: 'POST' }));
    expect(response.headers.get('grpc-status')).toBe('12');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('');
  });
});

describe('M139b §3.3 — the transport bit and trailers', () => {
  it('a request without the adapter flag reports no trailers to refuses and handleRpc', async () => {
    const grpc = grpcPlugin({
      handleRpc: () => Promise.resolve(reply('x')),
    });
    const app = await started(grpc);
    await app.inject({ method: 'POST', url: '/pkg.Svc/Method' });
    expect(grpc.seen.refuseTransports).toEqual([
      { trailers: false, signal: expect.any(AbortSignal) },
    ]);
    expect(grpc.seen.transports).toEqual([{ trailers: false, signal: expect.any(AbortSignal) }]);
  });

  it('an adapter-flagged request reports trailers, and the reply keeps them through the kernel', async () => {
    const trailers = Promise.resolve(new Headers({ 'grpc-status': '0' }));
    const grpc = grpcPlugin({
      handleRpc: (): Promise<RpcReply> =>
        Promise.resolve(reply(new Response('payload').body, { streaming: false, trailers })),
    });
    const adapter = capturingAdapter();
    await started(adapter, grpc);
    const response = await adapter.handler()(
      new TrailerCapableRequest(new Request(URL_BASE, { method: 'POST' })),
    );
    expect(grpc.seen.refuseTransports).toEqual([
      { trailers: true, signal: expect.any(AbortSignal) },
    ]);
    expect(grpc.seen.transports).toEqual([{ trailers: true, signal: expect.any(AbortSignal) }]);
    const snapshot = response.snapshot();
    // A reply with trailers is streamed even when it is a single message, and
    // the kernel's empty-chunk guard re-wraps the body without dropping them.
    expect(snapshot.streaming).toBe(true);
    if (!snapshot.streaming) throw new Error('unreachable');
    expect(snapshot.trailers).toBe(trailers);
    expect(await new Response(snapshot.body).text()).toBe('payload');
  });

  it('trailers survive the deferred-cleanup re-wrap too', async () => {
    const trailers = Promise.resolve(new Headers({ 'grpc-status': '0' }));
    const app = createApplication({ plugins: [runtimePlugin()] });
    const adapter = capturingAdapter();
    app.register(adapter);
    app.register({
      name: 'defer-mw',
      version: '1.0.0',
      register(ctx) {
        ctx.middleware.add(async (c, next) => {
          c.defer?.(() => undefined);
          await next();
        });
      },
    });
    app.register(
      grpcPlugin({
        handleRpc: () => Promise.resolve(reply(new Response('p').body, { trailers })),
      }),
    );
    await app.start();
    const response = await adapter.handler()(
      new TrailerCapableRequest(new Request(URL_BASE, { method: 'POST' })),
    );
    const snapshot = response.snapshot();
    if (!snapshot.streaming) throw new Error('expected a stream');
    expect(snapshot.trailers).toBe(trailers);
    expect(await new Response(snapshot.body).text()).toBe('p');
  });
});

describe('M139b §3.2 — RPC request bodies', () => {
  function echoFirstChunk(streams: boolean): IPlugin & { seen: Seen } {
    return grpcPlugin({
      streamsRequest: () => streams,
      handleRpc: async (call) => {
        if (!(call.body instanceof ReadableStream)) return reply(call.body);
        const first = await call.body.getReader().read();
        return reply(first.value ?? new Uint8Array());
      },
    });
  }

  it('a streaming procedure gets the UNREAD body while the client is still sending', async () => {
    const body = manualStream();
    body.push('hello');
    const app = await started(echoFirstChunk(true));
    // The body never closes: buffering it would never resolve.
    const response = await within(
      app.dispatch!(
        new Request(URL_BASE, {
          method: 'POST',
          body: body.stream,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
      ),
    );
    expect(await response.text()).toBe('hello');
  });

  it('a non-streaming procedure is buffered', async () => {
    const grpc = echoFirstChunk(false);
    const app = await started(grpc);
    const response = await app.dispatch!(
      new Request(URL_BASE, { method: 'POST', body: 'whole body' }),
    );
    expect(await response.text()).toBe('whole body');
    const call = grpc.seen.calls[0]!;
    expect(call.body).toBeInstanceOf(Uint8Array);
    expect(call.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(call).toMatchObject({ method: 'POST', url: URL_BASE, path: '/pkg.Svc/Method' });
  });

  it('an implementor without streamsRequest is buffered', async () => {
    const grpc = grpcPlugin({
      handleRpc: (call) => Promise.resolve(reply(call.body as Uint8Array)),
    });
    const app = await started(grpc);
    const response = await app.dispatch!(new Request(URL_BASE, { method: 'POST', body: 'b' }));
    expect(await response.text()).toBe('b');
  });

  it('a body middleware already read is buffered from that read, not from the spent stream', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.register({
      name: 'reads-body',
      version: '1.0.0',
      register(ctx) {
        ctx.middleware.add(async (c, next) => {
          await c.request.bytes();
          await next();
        });
      },
    });
    const grpc = echoFirstChunk(true);
    app.register(grpc);
    await app.start();
    const response = await app.dispatch!(
      new Request(URL_BASE, { method: 'POST', body: 'already read' }),
    );
    expect(await response.text()).toBe('already read');
  });

  it.each([true, false])(
    'the client signal travels on the transport, not on the call (streamed body: %s)',
    async (streams) => {
      let transportSignal: AbortSignal | undefined;
      let seenCall: RpcCall | undefined;
      const app = await started(
        grpcPlugin({
          streamsRequest: () => streams,
          handleRpc: (call, transport) => {
            transportSignal = transport.signal;
            seenCall = call;
            return Promise.resolve(reply('ok'));
          },
        }),
      );
      const controller = new AbortController();
      await app.dispatch!(
        new Request(URL_BASE, { method: 'POST', body: 'x', signal: controller.signal }),
      );
      expect(transportSignal!.aborted).toBe(false);
      controller.abort();
      expect(transportSignal!.aborted).toBe(true);
      // The call is plain fields: no fetch Request, and so no signal to follow.
      expect(seenCall).not.toBeInstanceOf(Request);
      expect('signal' in seenCall!).toBe(false);
    },
  );

  it('a header a middleware set reaches the call', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.register({
      name: 'sets-header',
      version: '1.0.0',
      register(ctx) {
        ctx.middleware.add(async (c, next) => {
          c.request.headers.set('x-tenant', 't1');
          await next();
        });
      },
    });
    const grpc = grpcPlugin({ handleRpc: () => Promise.resolve(reply('ok')) });
    app.register(grpc);
    await app.start();
    await app.dispatch!(new Request(URL_BASE, { method: 'POST' }));
    expect(grpc.seen.calls[0]!.headers.get('x-tenant')).toBe('t1');
  });
});
