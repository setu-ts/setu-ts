/**
 * M139b §3.12 scenarios for the plugin's client, end to end on real sockets:
 * a serving application on `RuntimePlugin({ http2: true })` and a calling one
 * on `GrpcPlugin({ serve: false })` with real static service discovery.
 * Deadlines, cancellation, multiplexing on one connection, reconnection after
 * the connection dies, client- and bidi-streaming, application error codes,
 * failover, trace propagation, the other protocols, response metadata and the
 * server's message bound.
 *
 * @module
 */
import { connect, createServer } from 'node:net';
import { createServer as http1Server } from 'node:http';
import { createServer as http2Server } from 'node:http2';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create, createFileRegistry, fromBinary } from '@bufbuild/protobuf';
import type { DescService } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IServiceDiscovery, ITelemetryService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';
import type { EjectionOptions } from '@setu-ts/service-discovery-plugin';

import { grpcClient } from '../../src/client/grpc-client-helper.ts';
import { callOutcome } from '../../src/client/call-outcome.ts';
import {
  headerListSize,
  UNADVERTISED_HEADER_LIST_LIMIT,
} from '../../src/client/header-list-guard.ts';
import { GrpcHeaderListTooLargeError } from '../../src/errors/grpc-errors.ts';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import type { GrpcPluginOptions } from '../../src/interfaces/index.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';
import { unusedPort } from '../../../../test/node-helpers.ts';

const describeNode = describe.skipIf(typeof Deno !== 'undefined');

/** The fixture's services, plus `example.Collect` (client-streaming `Sum`, bidi `Chat`) over its messages. */
function services(): {
  echo: DescService;
  stream: DescService;
  collect: DescService;
  reflection: DescService;
} {
  const set = fromBinary(
    FileDescriptorSetSchema,
    Uint8Array.from(atob(ECHO_DESCRIPTOR_BASE64), (c) => c.charCodeAt(0)),
  );
  set.file.push(
    create(FileDescriptorProtoSchema, {
      name: 'collect.proto',
      package: 'example',
      dependency: ['echo.proto'],
      syntax: 'proto3',
      service: [
        {
          name: 'Collect',
          method: [
            {
              name: 'Sum',
              inputType: '.example.EchoRequest',
              outputType: '.example.EchoResponse',
              clientStreaming: true,
            },
            {
              name: 'Chat',
              inputType: '.example.EchoRequest',
              outputType: '.example.EchoResponse',
              clientStreaming: true,
              serverStreaming: true,
            },
          ],
        },
      ],
    }),
  );
  const registry = createFileRegistry(set);
  const reflectionSet = fromBinary(
    FileDescriptorSetSchema,
    Uint8Array.from(atob(EmbeddedDescriptors.reflectionBase64), (c) => c.charCodeAt(0)),
  );
  return {
    echo: registry.getService('example.EchoService')!,
    stream: registry.getService('example.StreamService')!,
    collect: registry.getService('example.Collect')!,
    reflection: createFileRegistry(reflectionSet).getService(
      'grpc.reflection.v1.ServerReflection',
    )!,
  };
}
const SVC = services();

describeNode.each(['connect', 'grpc', 'grpc-web'] as const)('instance faults on %s', (protocol) => {
  for (const fault of [
    'dead-port',
    'http1',
    'http2-missing',
    'accept-close',
    'no-error-close',
    'deadline',
    'json404',
  ] as const) {
    it(`ejects ${fault} after one call and the next five succeed`, async () => {
      const badPort = await unusedPort();
      if (
        fault === 'http1' ||
        fault === 'http2-missing' ||
        fault === 'accept-close' ||
        fault === 'no-error-close'
      ) {
        const server =
          fault === 'http1'
            ? http1Server((_req, res) => {
                res.writeHead(404);
                res.end();
              })
            : fault === 'http2-missing' || fault === 'no-error-close'
              ? http2Server()
              : createServer((socket) => socket.destroy());
        if (fault === 'http2-missing')
          (server as ReturnType<typeof http2Server>).on('stream', (stream) => {
            stream.respond({ ':status': 404 });
            stream.end();
          });
        if (fault === 'no-error-close')
          (server as ReturnType<typeof http2Server>).on('stream', (stream) => {
            stream.close(0);
          });
        await new Promise<void>((resolve) => server.listen(badPort, '127.0.0.1', resolve));
        closers.push(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
      } else if (fault !== 'dead-port') {
        const app = createApplication({
          plugins: [
            RuntimePlugin({ http2: true }),
            ...(fault === 'json404'
              ? []
              : [
                  GrpcPlugin({
                    basePath: '/grpc',
                    services: [
                      {
                        definition: SVC.echo,
                        implementation: {
                          echo: async (_request: unknown, context: { signal: AbortSignal }) => {
                            await new Promise<void>((resolve) => {
                              if (context.signal.aborted) resolve();
                              else
                                context.signal.addEventListener('abort', () => resolve(), {
                                  once: true,
                                });
                            });
                            return { response: 'too late' };
                          },
                        },
                      },
                    ],
                  }),
                ]),
          ],
        });
        await app.start({ port: badPort, hostname: '127.0.0.1' });
        apps.push(app);
      }
      const live = await startServer(fresh());
      const caller = await startCaller(
        [
          { id: 'bad', port: badPort },
          { id: 'live', port: live.port },
        ],
        { clients: { billing: { basePath: '/grpc', protocol, timeoutMs: 500 } } },
      );
      const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
      const error = await failure(billing.echo({ message: 'first' }));
      const causes: { code: unknown; name: unknown }[] = [];
      let current: unknown = error;
      for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
        const record = current as { code?: unknown; name?: unknown; cause?: unknown };
        causes.push({ code: record.code, name: record.name });
        current = record.cause;
      }
      expect(
        callOutcome(
          error,
          undefined,
          (value) => value instanceof ConnectError && value.isWireError,
        ),
        JSON.stringify({
          fault,
          protocol,
          code: error.code,
          wire: error.isWireError,
          metadata: [...error.metadata],
          causes,
        }),
      ).toBe('failure');
      const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
      expect((await discovery.pick('billing'))?.id).toBe('live');
      for (let n = 0; n < 5; n++)
        expect((await billing.echo({ message: 'ok' })).response).toBe('echo: ok');
    });
  }

  it('a handler that throws a plain Error reaches the caller as Internal and does not eject the instance', async () => {
    let thrown = 0;
    const throwing = createApplication({
      plugins: [
        RuntimePlugin({ http2: true }),
        GrpcPlugin({
          basePath: '/grpc',
          services: [
            {
              definition: SVC.echo,
              implementation: {
                echo: () => {
                  thrown++;
                  throw new Error('broken replica');
                },
              },
            },
          ],
        }),
      ],
    });
    const throwingPort = await unusedPort();
    await throwing.start({ port: throwingPort, hostname: '127.0.0.1' });
    apps.push(throwing);
    const live = await startServer(fresh());
    const caller = await startCaller(
      [
        { id: 'throwing', port: throwingPort },
        { id: 'live', port: live.port },
      ],
      {
        clients: { billing: { basePath: '/grpc', protocol } },
        ejection: {},
      },
    );
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    let internalAnswers = 0;
    let healthyAnswers = 0;
    // Six answers per instance exceed discovery's default five-failure window.
    // Under the old rule the throwing instance is ejected after its fifth answer.
    for (let n = 0; n < 12; n++) {
      try {
        const reply = await billing.echo({ message: 'ok' });
        expect(reply.response).toBe('echo: ok');
        healthyAnswers++;
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectError);
        const answer = ConnectError.from(error);
        expect(answer.code).toBe(Code.Internal);
        expect(answer.rawMessage).toBe('internal error');
        expect(answer.isWireError).toBe(true);
        internalAnswers++;
      }
    }
    expect(thrown).toBe(6);
    expect(internalAnswers).toBe(6);
    expect(healthyAnswers).toBe(6);
    const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    const picked = new Set<string>();
    for (let n = 0; n < 4; n++) picked.add((await discovery.pick('billing'))!.id);
    expect([...picked].sort()).toEqual(['live', 'throwing']);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the serving side observed. */
interface Observed {
  aborted: string[];
  traceparents: (string | null)[];
}

const apps: IKernelApplication[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => undefined);
  for (const close of closers.splice(0)) await close();
});

/** The serving member under `/grpc` on h2c. */
async function startServer(
  observed: Observed,
  options: Partial<GrpcPluginOptions> = {},
  port?: number,
): Promise<{ app: IKernelApplication; port: number }> {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ http2: true }),
      GrpcPlugin({
        basePath: '/grpc',
        ...options,
        services: [
          {
            definition: SVC.echo,
            implementation: {
              echo: async (
                request: { message: string },
                context: {
                  requestHeader: Headers;
                  responseHeader: Headers;
                  responseTrailer: Headers;
                  signal: AbortSignal;
                },
              ) => {
                observed.traceparents.push(context.requestHeader.get('traceparent'));
                if (request.message === 'invalid') {
                  throw new ConnectError('no such SKU', Code.InvalidArgument);
                }
                if (request.message.startsWith('slow:')) {
                  const ms = Number(request.message.slice(5));
                  await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, ms);
                    context.signal.addEventListener('abort', () => {
                      clearTimeout(timer);
                      observed.aborted.push(request.message);
                      resolve();
                    });
                  });
                }
                context.responseHeader.set('x-served-by', 'billing');
                context.responseTrailer.set('x-total', '42');
                return { response: `echo: ${request.message}` };
              },
              ping: () => ({ pong: true }),
            },
          },
          {
            definition: SVC.stream,
            implementation: {
              serverStream: async function* (request: { prefix: string }) {
                for (let i = 0; i < 3; i++) yield { message: `${request.prefix}-${i}` };
              },
            },
          },
          {
            definition: SVC.collect,
            implementation: {
              sum: async (requests: AsyncIterable<{ message: string }>) => {
                const seen: string[] = [];
                for await (const r of requests) seen.push(r.message);
                return { response: seen.join('+') };
              },
              chat: async function* (requests: AsyncIterable<{ message: string }>) {
                for await (const r of requests) yield { response: `re: ${r.message}` };
              },
            },
          },
        ],
      }),
    ],
  });
  const bound = port ?? (await unusedPort());
  await app.start({ port: bound, hostname: '127.0.0.1' });
  apps.push(app);
  return { app, port: bound };
}

/** A TCP proxy that counts connections and can cut them all. */
async function startProxy(
  target: number,
): Promise<{ port: number; connections(): number; cut(): void }> {
  const sockets = new Set<Socket>();
  let count = 0;
  const server = createServer((inbound) => {
    count++;
    const upstream = connect(target, '127.0.0.1');
    sockets.add(inbound).add(upstream);
    inbound.pipe(upstream).pipe(inbound);
    const drop = (): void => {
      inbound.destroy();
      upstream.destroy();
    };
    inbound.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
  });
  const port = await unusedPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    port,
    connections: () => count,
    cut: () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
  };
}

/** The calling member: no gRPC mount, static discovery for `billing`. */
async function startCaller(
  instances: { id: string; port: number }[],
  options: {
    clients?: GrpcPluginOptions['clients'];
    extra?: IPlugin[];
    ejection?: EjectionOptions;
  } = {},
): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ServiceDiscoveryPlugin({
        provider: 'static',
        services: { billing: instances.map((i) => ({ ...i, host: '127.0.0.1' })) },
        ejection: options.ejection ?? {
          failureThreshold: 1,
          windowMs: 60_000,
          durationMs: 60_000,
          maxEjectionPercent: 100,
        },
      }),
      GrpcPlugin({ serve: false, clients: options.clients ?? { billing: { basePath: '/grpc' } } }),
      ...(options.extra ?? []),
    ],
  });
  await app.start({ port: await unusedPort(), hostname: '127.0.0.1' });
  apps.push(app);
  return app;
}

/** The error a call rejects with; a call that answers fails the test. */
function failure(call: Promise<unknown>): Promise<ConnectError> {
  return call.then(
    () => {
      throw new Error('the call answered');
    },
    (error: unknown) => ConnectError.from(error),
  );
}

interface Echo {
  echo(
    request: { message: string },
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      headers?: HeadersInit;
      onHeader?: (headers: Headers) => void;
      onTrailer?: (trailers: Headers) => void;
    },
  ): Promise<{ response: string }>;
}

const fresh = (): Observed => ({ aborted: [], traceparents: [] });

describeNode('grpcClient scenarios', () => {
  it('a per-target deadline ends a slow call as DeadlineExceeded and aborts the handler; a per-call one overrides it', async () => {
    const observed = fresh();
    const { port } = await startServer(observed);
    const caller = await startCaller([{ id: 'b', port }], {
      clients: { billing: { basePath: '/grpc', timeoutMs: 150 } },
    });
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    const started = performance.now();
    const late = await failure(billing.echo({ message: 'slow:2000' }));
    expect([Code[late.code], performance.now() - started < 1000]).toEqual([
      'DeadlineExceeded',
      true,
    ]);
    await sleep(100);
    expect(observed.aborted).toEqual(['slow:2000']);
    expect((await billing.echo({ message: 'slow:300' }, { timeoutMs: 2000 })).response).toBe(
      'echo: slow:300',
    );
  });

  it("the caller's AbortSignal cancels the call and reaches the handler", async () => {
    const observed = fresh();
    const { port } = await startServer(observed);
    const caller = await startCaller([{ id: 'b', port }]);
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await failure(
      billing.echo({ message: 'slow:3000' }, { signal: controller.signal }),
    );
    expect(Code[cancelled.code]).toBe('Canceled');
    await sleep(150);
    expect(observed.aborted).toEqual(['slow:3000']);
  });

  it('fifty concurrent calls share one connection; after the connection is cut the client reconnects', async () => {
    const { port } = await startServer(fresh());
    const proxy = await startProxy(port);
    const caller = await startCaller([{ id: 'b', port: proxy.port }]);
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    const answers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => billing.echo({ message: String(i) })),
    );
    expect(answers.map((a) => a.response)).toEqual(
      Array.from({ length: 50 }, (_, i) => `echo: ${i}`),
    );
    expect(proxy.connections()).toBe(1);

    proxy.cut();
    await sleep(50);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(
        await billing.echo({ message: 'again' }).then(
          (a) => a.response,
          (e: unknown) => Code[ConnectError.from(e).code]!,
        ),
      );
    }
    // The cut may cost the first call; every later one is served on a new connection.
    expect(outcomes.slice(1)).toEqual(['echo: again', 'echo: again']);
    expect(proxy.connections()).toBe(2);
  });

  it('client-streaming, bidi and server-streaming calls work through the plugin client', async () => {
    const { port } = await startServer(fresh());
    const caller = await startCaller([{ id: 'b', port }]);
    const collect = grpcClient(caller.services, SVC.collect, 'billing') as unknown as {
      sum(requests: AsyncIterable<{ message: string }>): Promise<{ response: string }>;
      chat(requests: AsyncIterable<{ message: string }>): AsyncIterable<{ response: string }>;
    };
    async function* three(): AsyncIterable<{ message: string }> {
      for (const message of ['a', 'b', 'c']) {
        await sleep(10);
        yield { message };
      }
    }
    expect((await collect.sum(three())).response).toBe('a+b+c');
    const replies: string[] = [];
    for await (const reply of collect.chat(three())) replies.push(reply.response);
    expect(replies).toEqual(['re: a', 're: b', 're: c']);

    const stream = grpcClient(caller.services, SVC.stream, 'billing') as unknown as {
      serverStream(request: { prefix: string }): AsyncIterable<{ message: string }>;
    };
    const messages: string[] = [];
    for await (const m of stream.serverStream({ prefix: 'n' })) messages.push(m.message);
    expect(messages).toEqual(['n-0', 'n-1', 'n-2']);

    // The plugin's own bidi reflection, through the same client.
    const reflection = grpcClient(caller.services, SVC.reflection, 'billing') as unknown as {
      serverReflectionInfo(
        requests: AsyncIterable<{ messageRequest: { case: 'listServices'; value: string } }>,
      ): AsyncIterable<{
        messageResponse: { case: string; value: { service?: { name: string }[] } };
      }>;
    };
    async function* list(): AsyncIterable<{
      messageRequest: { case: 'listServices'; value: string };
    }> {
      yield { messageRequest: { case: 'listServices', value: '' } };
    }
    const names: string[] = [];
    for await (const r of reflection.serverReflectionInfo(list())) {
      for (const s of r.messageResponse.value.service ?? []) names.push(s.name);
    }
    expect(names).toContain('example.Collect');
  });

  it('an application error code reaches the caller and does not eject the instance', async () => {
    const { port } = await startServer(fresh());
    const caller = await startCaller([{ id: 'b', port }]);
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    const invalid = await failure(billing.echo({ message: 'invalid' }));
    expect([Code[invalid.code], invalid.rawMessage]).toEqual(['InvalidArgument', 'no such SKU']);
    const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    expect((await discovery.pick('billing'))?.id).toBe('b');
    expect((await billing.echo({ message: 'ok' })).response).toBe('echo: ok');
  });

  it('when one of two instances stops, calls keep succeeding on the other', async () => {
    const one = await startServer(fresh());
    const two = await startServer(fresh());
    const caller = await startCaller([
      { id: 'one', port: one.port },
      { id: 'two', port: two.port },
    ]);
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    for (let i = 0; i < 4; i++) await billing.echo({ message: 'warm' });
    await one.app.stop();
    apps.splice(apps.indexOf(one.app), 1);
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(
        await billing.echo({ message: 'x' }).then(
          () => 'ok',
          (e: unknown) => Code[ConnectError.from(e).code]!,
        ),
      );
    }
    // Stopping sends GOAWAY, so a call already on the wire is refused
    // (REFUSED_STREAM). The client reports that as the instance's failure, which
    // ejects it, and sends the call once more to the other instance: no call
    // fails. Without the retry the first answered Internal and the next went to
    // the dead instance again.
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('carries the active span as traceparent, and leaves a call without one bare', async () => {
    const observed = fresh();
    const { port } = await startServer(observed);
    let active: ReturnType<NonNullable<ITelemetryService['activeSpanContext']>>;
    const telemetry: IPlugin = {
      name: 'fake-telemetry',
      version: '0.0.0',
      provides: [CAPABILITIES.TELEMETRY],
      register(ctx) {
        ctx.services.register<ITelemetryService>(CAPABILITIES.TELEMETRY, {
          withSpan: (_name, fn) => fn({} as never),
          activeSpanContext: () => active,
        });
      },
    };
    const caller = await startCaller([{ id: 'b', port }], { extra: [telemetry] });
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    active = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' };
    await billing.echo({ message: 'traced' });
    active = undefined;
    await billing.echo({ message: 'bare' });
    expect(observed.traceparents).toEqual([`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, null]);
  });

  it('gRPC-Web and Connect over HTTP/1.1 reach the same server', async () => {
    const { port } = await startServer(fresh());
    const caller = await startCaller([{ id: 'b', port }]);
    const web = grpcClient(caller.services, SVC.echo, 'billing', {
      protocol: 'grpc-web',
    }) as unknown as Echo;
    const h1 = grpcClient(caller.services, SVC.echo, 'billing', {
      httpVersion: '1.1',
    }) as unknown as Echo;
    expect((await web.echo({ message: 'web' })).response).toBe('echo: web');
    expect((await h1.echo({ message: 'h1' })).response).toBe('echo: h1');
  });

  it("response headers and trailers reach the caller's callbacks, on Connect and native gRPC", async () => {
    const { port } = await startServer(fresh());
    const caller = await startCaller([{ id: 'b', port }]);
    for (const protocol of ['connect', 'grpc'] as const) {
      const billing = grpcClient(caller.services, SVC.echo, 'billing', {
        protocol,
      }) as unknown as Echo;
      let header: string | null = null;
      let trailer: string | null = null;
      await billing.echo(
        { message: 'meta' },
        {
          onHeader: (h) => (header = h.get('x-served-by')),
          onTrailer: (t) => (trailer = t.get('x-total')),
        },
      );
      expect([protocol, header, trailer]).toEqual([protocol, 'billing', '42']);
    }
  });

  it('sixteen 1 MB calls in flight on one session all answer (the client session cap)', async () => {
    const { port } = await startServer(fresh());
    const caller = await startCaller([{ id: 'b', port }]);
    const billing = grpcClient(caller.services, SVC.echo, 'billing', {
      protocol: 'grpc',
    }) as unknown as Echo;
    const big = 'x'.repeat(1024 * 1024);
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, () =>
        billing.echo({ message: big }).then(
          (r) => r.response.length,
          (e: unknown) => ConnectError.from(e).rawMessage,
        ),
      ),
    );
    expect(outcomes).toEqual(Array.from({ length: 16 }, () => 'echo: '.length + big.length));
  });

  it("a message over the server's readMaxBytes is refused as ResourceExhausted", async () => {
    const { port } = await startServer(fresh(), { readMaxBytes: 64 });
    const caller = await startCaller([{ id: 'b', port }]);
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    const refused = await failure(billing.echo({ message: 'x'.repeat(200) }));
    expect(Code[refused.code]).toBe('ResourceExhausted');
    expect((await billing.echo({ message: 'small' })).response).toBe('echo: small');
  });
});

describeNode('grpcClient and a peer header-list limit', () => {
  it('does not report or resend six 70 KiB header refusals from healthy Setu servers with no advertised limit', async () => {
    const observed = [fresh(), fresh()];
    const a = await startServer(observed[0]!);
    const b = await startServer(observed[1]!);
    // Each manager binds request when its guard is installed, so observe the
    // prototype before constructing the caller, including its first sessions.
    const { Http2SessionManager } = await import('@connectrpc/connect-node');
    let sentSize = 0;
    const request = Http2SessionManager.prototype.request;
    const requests = vi
      .spyOn(Http2SessionManager.prototype, 'request')
      .mockImplementation(async function (this: InstanceType<typeof Http2SessionManager>, ...args) {
        const stream = await request.apply(this, args);
        sentSize = headerListSize(stream.sentHeaders);
        expect(stream.session!.remoteSettings.maxHeaderListSize).toBe(4294967295);
        return stream;
      });
    const caller = await startCaller(
      [
        { id: 'a', port: a.port },
        { id: 'b', port: b.port },
      ],
      { ejection: {} },
    );
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    const picks = vi.spyOn(discovery, 'pick');
    const reports = vi.spyOn(discovery, 'report');
    try {
      // No warm-up: the fallback must also work on a session's first call.
      const errors: ConnectError[] = [];
      for (let n = 0; n < 6; n++) {
        errors.push(
          await failure(
            billing.echo({ message: 'big' }, { headers: { 'x-big': 'a'.repeat(70 * 1024) } }),
          ),
        );
      }
      const picked = new Set<string>();
      for (let n = 0; n < 4; n++) picked.add((await discovery.pick('billing'))!.id);
      expect([...picked].sort()).toEqual(['a', 'b']);
      expect(picks).toHaveBeenCalledTimes(10); // six attempts, four ejection reads
      expect(reports).not.toHaveBeenCalled();
      for (const error of errors) {
        let cause: unknown = error;
        let headerError: GrpcHeaderListTooLargeError | undefined;
        for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth++) {
          if (cause instanceof GrpcHeaderListTooLargeError) headerError = cause;
          cause = (cause as { cause?: unknown }).cause;
        }
        expect(headerError, error.message).toBeInstanceOf(GrpcHeaderListTooLargeError);
        expect(headerError!.size).toBeGreaterThan(UNADVERTISED_HEADER_LIST_LIMIT);
        expect(headerError!.limit).toBe(UNADVERTISED_HEADER_LIST_LIMIT);
      }
      expect(observed.map((o) => o.traceparents.length)).toEqual([0, 0]);
      for (let n = 0; n < 2; n++) {
        expect((await billing.echo({ message: 'normal' })).response).toBe('echo: normal');
      }
      expect(observed.map((o) => o.traceparents.length)).toEqual([1, 1]);

      // Capture the actual Node sentHeaders to size the complete list, including
      // pseudo-headers and Connect metadata, exactly one octet below 64 KiB.
      await billing.echo({ message: 'under' }, { headers: { 'x-boundary': 'a' } });
      const baseline = sentSize;
      const value = 'a'.repeat(UNADVERTISED_HEADER_LIST_LIMIT - baseline);
      expect(
        (await billing.echo({ message: 'under' }, { headers: { 'x-boundary': value } })).response,
      ).toBe('echo: under');
      expect(sentSize).toBe(UNADVERTISED_HEADER_LIST_LIMIT - 1);
    } finally {
      requests.mockRestore();
      picks.mockRestore();
      reports.mockRestore();
    }
  });

  it('stops an over-limit call before a peer processes it and never ejects the healthy instances', async () => {
    const { connectNodeAdapter } = await import('@connectrpc/connect-node');
    const limit = 4096;
    const served: Record<string, number> = { a: 0, b: 0 };
    const instances: { id: string; port: number }[] = [];
    for (const id of ['a', 'b']) {
      const port = await unusedPort();
      const server = http2Server(
        { settings: { maxHeaderListSize: limit } },
        connectNodeAdapter({
          requestPathPrefix: '/grpc',
          routes: (router) => {
            router.service(SVC.echo, {
              echo: (request: { message: string }) => {
                served[id]! += 1;
                return { response: `echo: ${request.message}` };
              },
            } as never);
          },
        }),
      );
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      closers.push(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.unref();
          }),
      );
      instances.push({ id, port });
    }
    const caller = await startCaller(instances);
    const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
    // One ordinary call per instance opens its session; a completed call means
    // the peer's SETTINGS have arrived. The first call on a new session is not
    // checked (documented), so the guard is exercised from the second on.
    for (let n = 0; n < 2; n++) await billing.echo({ message: 'warm' });
    const before = { ...served };
    // Stay above 8 KiB: a smaller call would now count against the instance.
    const big = { 'x-big': 'a'.repeat(8193) };
    for (let n = 0; n < 10; n++) {
      const error = await failure(billing.echo({ message: 'big' }, { headers: big }));
      let cause: unknown = error;
      let named = false;
      for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth++) {
        if ((cause as { name?: unknown }).name === 'GrpcHeaderListTooLargeError') named = true;
        cause = (cause as { cause?: unknown }).cause;
      }
      expect(named, JSON.stringify({ code: error.code, message: error.rawMessage })).toBe(true);
    }
    // No peer processed an over-limit call, and both instances stay in rotation.
    expect(served).toEqual(before);
    const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    const picked = new Set<string>();
    for (let n = 0; n < 4; n++) picked.add((await discovery.pick('billing'))!.id);
    expect([...picked].sort()).toEqual(['a', 'b']);
    // A header list under the limit still goes through: the guard counts what was sent.
    const underLimit = { 'x-small': 'a'.repeat(limit - 1024) };
    expect((await billing.echo({ message: 'small' }, { headers: underLimit })).response).toBe(
      'echo: small',
    );
  });

  it('resends normal headers from a small-limit instance and ejects it after five failures', async () => {
    const { connectNodeAdapter, Http2SessionManager } = await import('@connectrpc/connect-node');
    const limit = 1024;
    let smallServed = 0;
    const smallPort = await unusedPort();
    const server = http2Server(
      { settings: { maxHeaderListSize: limit } },
      connectNodeAdapter({
        requestPathPrefix: '/grpc',
        routes: (router) => {
          router.service(SVC.echo, {
            echo: (request: { message: string }) => {
              smallServed++;
              return { response: `echo: ${request.message}` };
            },
          } as never);
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(smallPort, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.unref();
        }),
    );
    const observed = fresh();
    const healthy = await startServer(observed);
    const request = Http2SessionManager.prototype.request;
    const sent: { size: number; limit: number | undefined }[] = [];
    const requests = vi
      .spyOn(Http2SessionManager.prototype, 'request')
      .mockImplementation(async function (this: InstanceType<typeof Http2SessionManager>, ...args) {
        const stream = await request.apply(this, args);
        sent.push({
          size: headerListSize(stream.sentHeaders),
          limit: stream.session!.remoteSettings.maxHeaderListSize,
        });
        return stream;
      });
    try {
      const caller = await startCaller(
        [
          { id: 'small', port: smallPort },
          { id: 'healthy', port: healthy.port },
        ],
        { ejection: {} },
      );
      const billing = grpcClient(caller.services, SVC.echo, 'billing') as unknown as Echo;
      // Finish one call per session so SETTINGS are known before testing the guard.
      for (let n = 0; n < 2; n++) await billing.echo({ message: 'warm' });
      expect(smallServed).toBe(1);
      const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
      const reports = vi.spyOn(discovery, 'report');
      try {
        sent.length = 0;
        for (let n = 0; n < 5; n++) {
          expect(
            (
              await billing.echo(
                { message: 'normal' },
                { headers: { 'x-normal': 'a'.repeat(2048) } },
              )
            ).response,
          ).toBe('echo: normal');
        }
        // Each call was stopped locally on small, then succeeded on a fresh healthy pick.
        expect(sent).toHaveLength(10);
        for (const entry of sent) {
          expect(entry.size).toBeGreaterThan(limit);
          expect(entry.size).toBeLessThanOrEqual(8192);
        }
        expect(sent.map((entry) => entry.limit)).toEqual(
          Array.from({ length: 5 }, () => [limit, 4294967295]).flat(),
        );
        expect(reports.mock.calls.map(([instance, outcome]) => [instance.id, outcome])).toEqual(
          Array.from({ length: 5 }, () => [
            ['small', 'failure'],
            ['healthy', 'success'],
          ]).flat(),
        );
        expect(smallServed).toBe(1);
        expect(observed.traceparents).toHaveLength(6); // warm-up plus all five resends
        const picked = new Set<string>();
        for (let n = 0; n < 4; n++) picked.add((await discovery.pick('billing'))!.id);
        expect([...picked]).toEqual(['healthy']);
      } finally {
        reports.mockRestore();
      }
    } finally {
      requests.mockRestore();
    }
  });
});
