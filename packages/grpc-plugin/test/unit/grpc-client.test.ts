import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  GrpcServiceDefinition,
  IGrpcService,
  IServiceDiscovery,
  IServiceRegistry,
  ITelemetryService,
  ServiceInstance,
} from '@setu-ts/common';

import {
  CLIENT_DEFAULTS,
  CLIENT_MAX_SESSION_MEMORY_MB,
  GrpcClients,
  instanceOrigin,
  isRefusedStream,
  MAX_CLIENT_ORIGINS,
  targetBase,
  validateClientOptions,
  WORKERS_REFUSAL,
} from '../../src/client/grpc-client.ts';
import type { GrpcClientDeps } from '../../src/client/grpc-client.ts';
import { grpcClient } from '../../src/client/grpc-client-helper.ts';
import {
  CONNECT_NODE_SPECIFIER,
  importConnectNode,
  loadConnectNode,
} from '../../src/client/connect-node-loader.ts';
import type { ConnectNodeModuleLike } from '../../src/client/connect-node-loader.ts';
import { GrpcRuntimeLoadError } from '../../src/errors/grpc-errors.ts';
import type { ClientTransportLike } from '../../src/interfaces/connect-runtime.ts';
import { GrpcService } from '../../src/services/grpc-service.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';
import {
  createFakeConnectRuntime,
  FakeUnavailableError,
} from '../fixtures/fake-connect-runtime.ts';

const BILLING: GrpcServiceDefinition = { typeName: 'billing.v1.BillingService', method: {} };

/** What a fake transport was asked to do, and with which options it was built. */
interface Built {
  readonly kind: 'connect' | 'grpc' | 'grpc-web';
  readonly options: Record<string, unknown>;
  readonly calls: Array<{ kind: 'unary' | 'stream'; header: Headers }>;
}

/** A recording stand-in for `@connectrpc/connect-node`. */
function fakeNode(outcome: () => Promise<unknown> = () => Promise.resolve('ok')): {
  module: ConnectNodeModuleLike;
  built: Built[];
  sessions: Array<{ url: string; aborted: boolean }>;
  sessionOptionsSeen: Array<Record<string, unknown> | undefined>;
} {
  const built: Built[] = [];
  const sessions: Array<{ url: string; aborted: boolean }> = [];
  const sessionOptionsSeen: Array<Record<string, unknown> | undefined> = [];
  const factory =
    (kind: Built['kind']) =>
    (options: Record<string, unknown>): ClientTransportLike => {
      const entry: Built = { kind, options, calls: [] };
      built.push(entry);
      // The client sets traceparent on the call's own headers; there is no interceptor.
      const intercepted = (header: HeadersInit | undefined): Promise<Headers> => {
        expect(options['interceptors']).toBeUndefined();
        return Promise.resolve(new Headers(header));
      };
      return {
        async unary(_method, _signal, _timeoutMs, header) {
          entry.calls.push({ kind: 'unary', header: await intercepted(header) });
          return outcome();
        },
        async stream(_method, _signal, _timeoutMs, header) {
          entry.calls.push({ kind: 'stream', header: await intercepted(header) });
          return outcome();
        },
      };
    };
  return {
    built,
    sessions,
    sessionOptionsSeen,
    module: {
      createConnectTransport: factory('connect'),
      createGrpcTransport: factory('grpc'),
      createGrpcWebTransport: factory('grpc-web'),
      Http2SessionManager: class {
        readonly #entry: { url: string; aborted: boolean };
        // connect-node's arity: (url, pingOptions?, http2SessionOptions?).
        constructor(url: string, ...rest: [unknown?, Record<string, unknown>?]) {
          this.#entry = { url, aborted: false };
          sessions.push(this.#entry);
          sessionOptionsSeen.push(rest[1]);
        }
        abort(): void {
          this.#entry.aborted = true;
        }
      },
    },
  };
}

/** A discovery double that hands out instances in turn and records reports. */
function fakeDiscovery(instances: ServiceInstance[]): IServiceDiscovery & {
  reports: Array<[string, string]>;
  throwOnReport: boolean;
} {
  let next = 0;
  const reports: Array<[string, string]> = [];
  const discovery = {
    reports,
    throwOnReport: false,
    resolve: () => Promise.resolve(instances),
    pick: () =>
      Promise.resolve(instances.length === 0 ? null : instances[next++ % instances.length]!),
    resolveUrl: () => Promise.resolve(null),
    report(instance: ServiceInstance, outcome: string) {
      if (discovery.throwOnReport) throw new Error('report failed');
      reports.push([instance.id, outcome]);
    },
    subscribe: () => () => {},
  };
  return discovery as unknown as IServiceDiscovery & {
    reports: Array<[string, string]>;
    throwOnReport: boolean;
  };
}

const instance = (
  id: string,
  port: number,
  extra: Partial<ServiceInstance> = {},
): ServiceInstance => ({
  id,
  serviceName: 'billing',
  host: '127.0.0.1',
  port,
  ...extra,
});

/** Calls a client's unary method the way Connect's `createClient` would. */
function call(client: unknown, header?: HeadersInit): Promise<unknown> {
  const { transport } = client as { transport: ClientTransportLike };
  return transport.unary({}, undefined, undefined, header, {});
}

function callStream(client: unknown): Promise<unknown> {
  const { transport } = client as { transport: ClientTransportLike };
  return transport.stream({}, undefined, undefined, undefined, (async function* () {})());
}

function clients(
  overrides: Partial<GrpcClientDeps> = {},
  node = fakeNode(),
): {
  clients: GrpcClients;
  node: ReturnType<typeof fakeNode>;
} {
  return {
    node,
    clients: new GrpcClients({
      runtime: createFakeConnectRuntime(),
      loadNode: () => Promise.resolve(node.module),
      discovery: () => undefined,
      telemetry: () => undefined,
      targets: {},
      ...overrides,
    }),
  };
}

describe('validateClientOptions', () => {
  it('accepts every documented value', () => {
    expect(() =>
      validateClientOptions(
        { basePath: '/grpc', protocol: 'grpc', httpVersion: '2', timeoutMs: 1 },
        'x',
      ),
    ).not.toThrow();
    expect(() =>
      validateClientOptions({ basePath: '', timeoutMs: 2_147_483_647 }, 'x'),
    ).not.toThrow();
    expect(() =>
      validateClientOptions({ protocol: 'grpc-web', httpVersion: '1.1' }, 'x'),
    ).not.toThrow();
  });

  it.each([
    [
      { basePath: 'grpc' },
      "where: basePath must be '' or start with '/' and not end with one, received \"grpc\"",
    ],
    [
      { basePath: '/grpc/' },
      "where: basePath must be '' or start with '/' and not end with one, received \"/grpc/\"",
    ],
    [
      { basePath: 7 },
      "where: basePath must be '' or start with '/' and not end with one, received 7",
    ],
    [
      { protocol: 'rest' },
      "where: protocol must be 'connect', 'grpc' or 'grpc-web', received \"rest\"",
    ],
    [{ httpVersion: '3' }, "where: httpVersion must be '2' or '1.1', received \"3\""],
    [{ timeoutMs: 0 }, 'where: timeoutMs must be an integer from 1 to 2147483647, received 0'],
    [{ timeoutMs: 1.5 }, 'where: timeoutMs must be an integer from 1 to 2147483647, received 1.5'],
    [
      { timeoutMs: 2_147_483_648 },
      'where: timeoutMs must be an integer from 1 to 2147483647, received 2147483648',
    ],
    [{ protocol: 'grpc', httpVersion: '1.1' }, "where: protocol 'grpc' needs httpVersion '2'"],
  ])('refuses %j', (options, message) => {
    expect(() => validateClientOptions(options as never, 'where')).toThrow(new TypeError(message));
  });
});

describe('targetBase and instanceOrigin', () => {
  it('keeps a URL target as origin plus path, without a trailing slash', () => {
    expect(targetBase('http://billing:3410')).toBe('http://billing:3410');
    expect(targetBase('https://billing.example/grpc/')).toBe('https://billing.example/grpc');
  });

  it('reads a bare word as a service name', () => {
    expect(targetBase('billing')).toBeUndefined();
  });

  it('refuses an empty target and a URL that is not http', () => {
    expect(() => targetBase('')).toThrow(
      new TypeError('grpc client: target must be a URL or a service name'),
    );
    expect(() => targetBase('ftp://billing')).toThrow(
      new TypeError('grpc client: target URL must be http or https, received ftp:'),
    );
  });

  it('formats an instance as the discovery plugin does', () => {
    expect(instanceOrigin(instance('a', 1))).toBe('http://127.0.0.1:1');
    expect(instanceOrigin(instance('b', 2, { host: '::1', secure: true }))).toBe('https://[::1]:2');
  });
});

describe('GrpcClients', () => {
  it('builds Connect over HTTP/2 with the defaults, one session per origin', async () => {
    const { clients: c, node } = clients();
    const client = c.client(BILLING, 'http://127.0.0.1:3410');
    expect(await call(client)).toBe('ok');
    expect(await call(client)).toBe('ok');
    expect(node.built).toHaveLength(1);
    expect(node.built[0]!.kind).toBe('connect');
    expect(node.built[0]!.options).toMatchObject({
      baseUrl: 'http://127.0.0.1:3410',
      httpVersion: '2',
      useBinaryFormat: true,
      defaultTimeoutMs: CLIENT_DEFAULTS.timeoutMs,
    });
    expect(node.built[0]!.options['sessionManager']).toBeDefined();
    expect(node.sessions).toEqual([{ url: 'http://127.0.0.1:3410', aborted: false }]);
    expect(node.sessionOptionsSeen).toEqual([{ maxSessionMemory: CLIENT_MAX_SESSION_MEMORY_MB }]);
    expect(CLIENT_MAX_SESSION_MEMORY_MB).toBe(64);
    expect(CLIENT_DEFAULTS).toEqual({
      basePath: '',
      protocol: 'connect',
      httpVersion: '2',
      timeoutMs: 5000,
    });
  });

  it('per-call options override the per-target entry, which overrides the defaults', async () => {
    const { clients: c, node } = clients({
      targets: { 'http://h:1': { basePath: '/grpc', protocol: 'grpc-web', timeoutMs: 100 } },
    });
    await call(c.client(BILLING, 'http://h:1', { timeoutMs: 250, httpVersion: '1.1' }));
    expect(node.built[0]!.kind).toBe('grpc-web');
    expect(node.built[0]!.options).toMatchObject({
      baseUrl: 'http://h:1/grpc',
      httpVersion: '1.1',
      defaultTimeoutMs: 250,
    });
    expect(node.built[0]!.options['sessionManager']).toBeUndefined();
    expect(node.sessions).toEqual([]);
  });

  it('builds a native gRPC transport for protocol grpc', async () => {
    const { clients: c, node } = clients();
    await call(c.client(BILLING, 'http://h:1', { protocol: 'grpc' }));
    expect(node.built[0]!.kind).toBe('grpc');
  });

  it('refuses a per-target entry that combines into an invalid pair', () => {
    const { clients: c } = clients({ targets: { 'http://h:1': { protocol: 'grpc' } } });
    expect(() => c.client(BILLING, 'http://h:1', { httpVersion: '1.1' })).toThrow(
      new TypeError("grpc client: protocol 'grpc' needs httpVersion '2'"),
    );
  });

  it('returns the same client for the same definition, target and options', () => {
    const { clients: c } = clients();
    const one = c.client(BILLING, 'http://h:1');
    expect(c.client(BILLING, 'http://h:1')).toBe(one);
    expect(c.client(BILLING, 'http://h:1', { timeoutMs: 9 })).not.toBe(one);
    expect(c.client({ ...BILLING }, 'http://h:1')).not.toBe(one);
  });

  it('refuses on Cloudflare Workers, where connect-node cannot call, and nowhere else', () => {
    const { clients: workers, node } = clients({ platform: () => 'cloudflare-workers' });
    expect(() => workers.client(BILLING, 'http://h:1')).toThrow(new TypeError(WORKERS_REFUSAL));
    expect(node.built).toHaveLength(0);
    for (const platform of ['node', 'bun', 'deno', undefined] as const) {
      const { clients: other } = clients({ platform: () => platform });
      expect(() => other.client(BILLING, 'http://h:1')).not.toThrow();
    }
  });

  it('refuses a service name when no discovery is registered', () => {
    const { clients: c } = clients();
    expect(() => c.client(BILLING, 'billing')).toThrow(
      new TypeError(
        'grpc client: "billing" is a service name, but no service discovery is registered; register ServiceDiscoveryPlugin or pass a URL',
      ),
    );
  });

  it('picks an instance per call and reports each outcome', async () => {
    const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
    let fail: Error | undefined;
    const node = fakeNode(() =>
      fail === undefined ? Promise.resolve('ok') : Promise.reject(fail),
    );
    const { clients: c } = clients(
      { discovery: () => discovery, targets: { billing: { basePath: '/grpc' } } },
      node,
    );
    const client = c.client(BILLING, 'billing');
    await call(client);
    await call(client);
    expect(node.built.map((b) => b.options['baseUrl'])).toEqual([
      'http://127.0.0.1:1/grpc',
      'http://127.0.0.1:2/grpc',
    ]);
    fail = new FakeUnavailableError('refused');
    await expect(call(client)).rejects.toBe(fail);
    fail = new Error('InvalidArgument from the server');
    await expect(callStream(client)).rejects.toBe(fail);
    expect(discovery.reports).toEqual([
      ['a', 'success'],
      ['b', 'success'],
      ['a', 'failure'],
      ['b', 'success'],
    ]);
  });

  it('a failing report does not change the call outcome', async () => {
    const discovery = fakeDiscovery([instance('a', 1)]);
    discovery.throwOnReport = true;
    const { clients: c } = clients({ discovery: () => discovery });
    expect(await call(c.client(BILLING, 'billing'))).toBe('ok');
  });

  it('rejects Unavailable when discovery has no instance, or has gone', async () => {
    const discovery = fakeDiscovery([]);
    let present = true;
    const { clients: c, node } = clients({ discovery: () => (present ? discovery : undefined) });
    const client = c.client(BILLING, 'billing');
    await expect(call(client)).rejects.toEqual(
      new FakeUnavailableError('no instance of "billing" is available'),
    );
    present = false;
    await expect(call(client)).rejects.toEqual(
      new FakeUnavailableError('no service discovery to resolve "billing"'),
    );
    expect(node.built).toHaveLength(0);
  });

  it('sets traceparent from the active span, keeps one the call carries, and skips without telemetry', async () => {
    let span: ReturnType<NonNullable<ITelemetryService['activeSpanContext']>>;
    let throws = false;
    const telemetry = {
      withSpan: () => Promise.resolve(undefined),
      activeSpanContext: () => {
        if (throws) throw new Error('telemetry broke');
        return span;
      },
    } as unknown as ITelemetryService;
    let present = true;
    const { clients: c, node } = clients({ telemetry: () => (present ? telemetry : undefined) });
    const client = c.client(BILLING, 'http://h:1');
    span = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' };
    await call(client);
    await call(client, { traceparent: '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(16) + '-00' });
    span = undefined;
    await call(client);
    span = { traceId: '0'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' };
    await call(client);
    throws = true;
    await call(client);
    present = false;
    await call(client);
    expect(node.built[0]!.calls.map((x) => x.header.get('traceparent'))).toEqual([
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`,
      null,
      null,
      null,
      null,
    ]);
  });

  it(`keeps at most ${MAX_CLIENT_ORIGINS} origins, closing the least recently used`, async () => {
    const { clients: c, node } = clients();
    const first = c.client(BILLING, 'http://h:0');
    await call(first);
    for (let port = 1; port < MAX_CLIENT_ORIGINS; port++)
      await call(c.client(BILLING, `http://h:${port}`));
    await call(first); // used again: now the most recent
    await call(c.client(BILLING, `http://h:${MAX_CLIENT_ORIGINS}`));
    expect(c.originCount).toBe(MAX_CLIENT_ORIGINS);
    expect(node.sessions.filter((s) => s.aborted).map((s) => s.url)).toEqual(['http://h:1']);
  });

  it('close aborts every session and later calls reject without opening one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const { clients: c, node } = clients({
      loadNode: async () => {
        await gate;
        return node.module;
      },
    });
    const client = c.client(BILLING, 'http://h:1');
    const pending = call(client);
    c.close();
    release();
    await expect(pending).rejects.toEqual(new FakeUnavailableError('the gRPC client is closed'));
    await expect(call(client)).rejects.toEqual(
      new FakeUnavailableError('the gRPC client is closed'),
    );
    expect(node.built).toHaveLength(0);

    const { clients: open, node: node2 } = clients();
    await call(open.client(BILLING, 'http://h:1'));
    open.close();
    expect(node2.sessions).toEqual([{ url: 'http://h:1', aborted: true }]);
    expect(open.originCount).toBe(0);
  });

  it('a missing connect-node rejects the call with the load error', async () => {
    const { clients: c } = clients({
      loadNode: () => loadConnectNode(() => Promise.reject(new Error('not installed'))),
    });
    const error = await call(c.client(BILLING, 'http://h:1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrpcRuntimeLoadError);
    expect((error as GrpcRuntimeLoadError).specifier).toBe(CONNECT_NODE_SPECIFIER);
    expect((error as Error).message).toBe(
      'Cannot load Connect runtime module: @connectrpc/connect-node. Run: deno add npm:@connectrpc/connect-node@^2.1.2 · npm i @connectrpc/connect-node · bun add @connectrpc/connect-node',
    );
  });
});

describe('connect-node loader', () => {
  it('imports the real package', async () => {
    const module = await loadConnectNode();
    expect(typeof module.createConnectTransport).toBe('function');
    expect(typeof module.Http2SessionManager).toBe('function');
    expect(await importConnectNode()).toBe(module);
  });
});

describe('grpcClient', () => {
  const registry = (service: Partial<IGrpcService>): IServiceRegistry =>
    ({
      get: (token: string) => {
        expect(token).toBe(CAPABILITIES.GRPC);
        return service;
      },
    }) as unknown as IServiceRegistry;

  it('asks the registered service for the client', () => {
    const seen: unknown[] = [];
    const client = grpcClient(
      registry({
        client: (...args: unknown[]) => {
          seen.push(args);
          return 'the client';
        },
      }),
      BILLING as never,
      'billing',
      { timeoutMs: 9 },
    );
    expect(client).toBe('the client');
    expect(seen).toEqual([[BILLING, 'billing', { timeoutMs: 9 }]]);
  });

  it('refuses a registered service without client()', () => {
    expect(() => grpcClient(registry({}), BILLING as never, 'billing')).toThrow(
      new TypeError(
        'grpcClient: the registered gRPC service has no client(); register GrpcPlugin from @setu-ts/grpc-plugin',
      ),
    );
  });

  it('a GrpcService built without clients refuses', () => {
    const service = new GrpcService({
      connectRuntime: createFakeConnectRuntime(),
      embeddedDescriptors: EmbeddedDescriptors,
      options: {},
      healthService: undefined,
    });
    expect(() => service.client(BILLING, 'billing')).toThrow(
      new TypeError('GrpcService: this service was built without clients; register GrpcPlugin'),
    );
  });
});

/** Node's error for a stream the server refused, as connect-node wraps it. */
function nodeRefusal(): Error {
  const node = Object.assign(new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
  });
  return Object.assign(
    new Error('[internal] Stream closed with error code NGHTTP2_REFUSED_STREAM'),
    {
      cause: node,
    },
  );
}

describe('refused streams (REFUSED_STREAM)', () => {
  it.each([
    ['Node stream error in the cause chain', nodeRefusal(), true],
    [
      "connect-node's reset-code reading",
      new FakeUnavailableError(
        '[unavailable] http/2 stream closed with error code REFUSED_STREAM (0x7)',
      ),
      true,
    ],
    [
      'the same text without the stream-error code',
      new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'),
      false,
    ],
    ['a server error naming the code', new Error('REFUSED_STREAM'), false],
    [
      'another reset',
      Object.assign(new Error('NGHTTP2_CANCEL'), { code: 'ERR_HTTP2_STREAM_ERROR' }),
      false,
    ],
    [
      'a stream that could not open after GOAWAY (Bun)',
      new Error('[internal] New streams cannot be created after receiving a GOAWAY', {
        cause: Object.assign(new Error('New streams cannot be created after receiving a GOAWAY'), {
          code: 'ERR_HTTP2_GOAWAY_SESSION',
        }),
      }),
      true,
    ],
    ['not an object', 'REFUSED_STREAM', false],
    [
      'a cycle deeper than five',
      (() => {
        const e: { message: string; cause?: unknown } = { message: 'x' };
        e.cause = e;
        return e;
      })(),
      false,
    ],
  ])('%s → %s', (_label, error, expected) => {
    expect(isRefusedStream(error)).toBe(expected);
  });

  it('retries a refused unary call once on a fresh pick, reporting the refusal as a failure', async () => {
    const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
    const results: Array<() => Promise<unknown>> = [
      () => Promise.reject(nodeRefusal()),
      () => Promise.resolve('ok'),
    ];
    const node = fakeNode(() => results.shift()!());
    const { clients: c } = clients({ discovery: () => discovery }, node);
    expect(await call(c.client(BILLING, 'billing'))).toBe('ok');
    expect(discovery.reports).toEqual([
      ['a', 'failure'],
      ['b', 'success'],
    ]);
  });

  it('a second refusal rejects as Unavailable, keeping the original as its cause', async () => {
    const discovery = fakeDiscovery([instance('a', 1)]);
    const refusal = nodeRefusal();
    const node = fakeNode(() => Promise.reject(refusal));
    const { clients: c } = clients({ discovery: () => discovery }, node);
    const error = (await call(c.client(BILLING, 'billing')).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(FakeUnavailableError);
    expect(error.message).toBe('"billing" refused the call before processing it');
    expect(discovery.reports).toEqual([
      ['a', 'failure'],
      ['a', 'failure'],
    ]);
  });

  it("keeps connect-node's own Unavailable reading as is, and fails the retry with a different error as that error", async () => {
    const reading = new FakeUnavailableError(
      '[unavailable] http/2 stream closed with error code REFUSED_STREAM (0x7)',
    );
    const other = new Error('InvalidArgument');
    const results: Array<() => Promise<unknown>> = [
      () => Promise.reject(reading),
      () => Promise.reject(other),
    ];
    const { clients: c } = clients(
      {},
      fakeNode(() => results.shift()!()),
    );
    expect(await call(c.client(BILLING, 'http://h:1')).catch((e: unknown) => e)).toBe(other);

    const twice = [() => Promise.reject(reading), () => Promise.reject(reading)];
    const { clients: d } = clients(
      {},
      fakeNode(() => twice.shift()!()),
    );
    expect(await call(d.client(BILLING, 'http://h:1')).catch((e: unknown) => e)).toBe(reading);
  });

  it('never retries a streaming call', async () => {
    let calls = 0;
    const node = fakeNode(() => {
      calls++;
      return Promise.reject(nodeRefusal());
    });
    const { clients: c } = clients({}, node);
    const error = await callStream(c.client(BILLING, 'http://h:1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FakeUnavailableError);
    expect(calls).toBe(1);
  });
});
