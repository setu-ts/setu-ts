import { describe, expect, it, vi } from 'vitest';
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
  MAX_CLIENTS_PER_DEFINITION,
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
  readonly calls: Array<{
    kind: 'unary' | 'stream';
    header: Headers;
    timeoutMs: number | undefined;
  }>;
}

/** A recording stand-in for `@connectrpc/connect-node`. */
function fakeNode(outcome: () => Promise<unknown> = () => Promise.resolve('ok')): {
  module: ConnectNodeModuleLike;
  built: Built[];
  sessions: Array<{ url: string; aborted: boolean }>;
  sessionOptionsSeen: Array<Record<string, unknown> | undefined>;
  /** A call to a base URL here waits on its promise before answering. */
  gates: Map<string, Promise<unknown>>;
} {
  const built: Built[] = [];
  const sessions: Array<{ url: string; aborted: boolean }> = [];
  const sessionOptionsSeen: Array<Record<string, unknown> | undefined> = [];
  const gates = new Map<string, Promise<unknown>>();
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
        async unary(_method, _signal, timeoutMs, header) {
          entry.calls.push({ kind: 'unary', header: await intercepted(header), timeoutMs });
          await gates.get(options['baseUrl'] as string);
          return outcome();
        },
        async stream(_method, _signal, timeoutMs, header) {
          entry.calls.push({ kind: 'stream', header: await intercepted(header), timeoutMs });
          await gates.get(options['baseUrl'] as string);
          return outcome();
        },
      };
    };
  return {
    built,
    sessions,
    sessionOptionsSeen,
    gates,
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
function call(client: unknown, header?: HeadersInit, timeoutMs?: number): Promise<unknown> {
  const { transport } = client as { transport: ClientTransportLike };
  return transport.unary({}, undefined, timeoutMs, header, {});
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
    for (const name of ['billing', 'billing.v1', 'billing_svc-2', 'B', 'a'.repeat(253)])
      expect(targetBase(name)).toBeUndefined();
  });

  it('refuses a target that is neither a URL nor a service name, without echoing it', () => {
    const refusal = new TypeError(
      "grpc client: a target must be an http(s) URL or a service name (letters, digits, '.', '_' and '-', at most 253)",
    );
    for (const target of [
      ' http://billing:3410/?s3cret',
      '\nhttp://billing?s3cret',
      'http:/billing?s3cret',
      'http:\\\\billing?s3cret',
      '//billing?s3cret',
      'billing:3410/grpc',
      'billing?s3cret',
      'billing#s3cret',
      'billing\r\nX-Injected: 1',
      'billing,other',
      '-billing',
      '.billing',
      'a'.repeat(254),
    ]) {
      expect(() => targetBase(target)).toThrow(refusal);
    }
  });

  it('refuses a URL that does not parse, without echoing it', () => {
    let caught: unknown;
    try {
      targetBase('http://bil ling:99999/s3cret');
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new TypeError('grpc client: the target URL does not parse'));
    expect(JSON.stringify(caught) + String((caught as Error).cause)).not.toContain('s3cret');
  });

  it('refuses a target carrying credentials, without echoing it', () => {
    const refusal = new TypeError(
      'grpc client: a target must not carry credentials (user:password@); send them as call headers',
    );
    for (const target of [
      'http://user:s3cret@billing:3410',
      'https://user@billing',
      'http://:s3cret@billing',
      'user:s3cret@billing',
    ]) {
      expect(() => targetBase(target)).toThrow(refusal);
    }
  });

  it('refuses a URL target with a query or fragment, without echoing it', () => {
    const refusal = new TypeError(
      'grpc client: a target URL must not carry a query or fragment; Connect never sends them',
    );
    for (const target of [
      'http://billing:3410/grpc?access_token=s3cret',
      'http://billing:3410#s3cret',
      'http://billing:3410?',
      'http://billing:3410/#',
    ]) {
      expect(() => targetBase(target)).toThrow(refusal);
    }
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
      readMaxBytes: 4 * 1024 * 1024,
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

  it("bounds every reply by the plugin's readMaxBytes, on all three transports", async () => {
    const { clients: c, node } = clients({ readMaxBytes: 1024 });
    await call(c.client(BILLING, 'http://h:1'));
    await call(c.client(BILLING, 'http://h:1', { protocol: 'grpc' }));
    await call(c.client(BILLING, 'http://h:1', { protocol: 'grpc-web' }));
    expect(node.built.map((b) => [b.kind, b.options['readMaxBytes']])).toEqual([
      ['connect', 1024],
      ['grpc', 1024],
      ['grpc-web', 1024],
    ]);
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

  /** A gate a test opens by hand. */
  const gate = (): { promise: Promise<void>; open: () => void } => {
    let open!: () => void;
    const promise = new Promise<void>((ok) => (open = ok));
    return { promise, open };
  };

  it('drains an evicted session with calls in flight, closing it at its last call', async () => {
    const { clients: c, node } = clients();
    const aborted = (): string[] => node.sessions.filter((s) => s.aborted).map((s) => s.url);
    const held = [gate(), gate()];
    node.gates.set('http://h:1000', held[0]!.promise);
    node.gates.set('http://h:1001', held[1]!.promise);
    const busy = [
      call(c.client(BILLING, 'http://h:1000')),
      call(c.client(BILLING, 'http://h:1001')),
      call(c.client(BILLING, 'http://h:1001')),
    ];
    for (let port = 2; port < MAX_CLIENT_ORIGINS + 3; port++)
      await call(c.client(BILLING, `http://h:${1000 + port}`));
    // h:1000 and h:1001 were evicted busy and drain; idle h:1002 closed at once.
    expect(aborted()).toEqual(['http://h:1002']);
    held[0]!.open();
    await busy[0];
    expect(aborted()).toEqual(['http://h:1000', 'http://h:1002']);
    held[1]!.open();
    await Promise.all(busy);
    // Its second call ended last: only then did it close.
    expect(aborted()).toEqual(['http://h:1000', 'http://h:1001', 'http://h:1002']);
    c.close();
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
  });

  it('never closes a busy evicted session, however many drain at once', async () => {
    const { clients: c, node } = clients();
    await call(c.client(BILLING, 'http://h:999')); // connect-node loaded: lookups are synchronous
    const held = gate();
    const busy: Array<Promise<unknown>> = [];
    for (let port = 0; port < MAX_CLIENT_ORIGINS * 3; port++) {
      // Port 80 would normalize away, so the ports start at 1000.
      node.gates.set(`http://h:${1000 + port}`, held.promise);
      busy.push(call(c.client(BILLING, `http://h:${1000 + port}`)));
    }
    // 129 evicted: idle h:999 closed, the 128 with calls in flight were not.
    expect(node.sessions.filter((s) => s.aborted).map((s) => s.url)).toEqual(['http://h:999']);
    c.close();
    // close() reaches the draining sessions as well as the cached ones.
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
    held.open();
    await Promise.all(busy);
  });

  it('counts a call from the lookup, so an eviction in the same turn cannot close it', async () => {
    const { clients: c, node } = clients();
    await call(c.client(BILLING, 'http://h:1000')); // warm, idle, the oldest
    const held = gate();
    node.gates.set('http://h:1000', held.promise);
    const mine = call(c.client(BILLING, 'http://h:1000'));
    const others = Array.from({ length: MAX_CLIENT_ORIGINS }, (_, i) =>
      call(c.client(BILLING, `http://h:${2000 + i}`)),
    );
    await Promise.all(others);
    const session = node.sessions.find((s) => s.url === 'http://h:1000')!;
    expect(session.aborted).toBe(false);
    held.open();
    await expect(mine).resolves.toBe('ok');
    expect(session.aborted).toBe(true);
  });

  it('tracks sessions created while connect-node loads, so close() reaches every one', async () => {
    const loaded = gate();
    const node = fakeNode();
    const { clients: c } = clients(
      {
        loadNode: async () => {
          await loaded.promise;
          return node.module;
        },
      },
      node,
    );
    const held = gate();
    const busy: Array<Promise<unknown>> = [];
    for (let port = 0; port < MAX_CLIENT_ORIGINS * 2; port++) {
      node.gates.set(`http://h:${1000 + port}`, held.promise);
      busy.push(call(c.client(BILLING, `http://h:${1000 + port}`)));
    }
    loaded.open();
    await new Promise((ok) => setTimeout(ok, 0));
    expect(node.sessions).toHaveLength(MAX_CLIENT_ORIGINS * 2);
    expect(node.sessions.filter((s) => s.aborted)).toEqual([]);
    c.close();
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
    held.open();
    await Promise.all(busy);
  });

  it('holds a streaming call until its messages end, fail, or are abandoned', async () => {
    let fail = false;
    const messages = (): AsyncIterable<unknown> => ({
      [Symbol.asyncIterator]: () => {
        let sent = 0;
        return {
          next: () =>
            fail
              ? Promise.reject(new Error('stream broke'))
              : Promise.resolve(
                  sent++ < 2 ? { done: false, value: sent } : { done: true, value: undefined },
                ),
        };
      },
    });
    const node = fakeNode(() =>
      Promise.resolve({ stream: true, header: 'h', message: messages() }),
    );
    const { clients: c } = clients({}, node);
    const session = (port: number) => node.sessions.find((s) => s.url === `http://h:${port}`)!;
    const evictAll = async (from: number): Promise<void> => {
      for (let i = 0; i < MAX_CLIENT_ORIGINS; i++)
        await callStream(c.client(BILLING, `http://h:${from + i}`));
    };
    const read = (response: unknown) =>
      (response as { message: AsyncIterable<unknown> }).message[Symbol.asyncIterator]();

    // Ends: the headers arrived, the messages had not; closed at the last message.
    const ended = (await callStream(c.client(BILLING, 'http://h:1000'))) as { header: string };
    expect(ended.header).toBe('h');
    await evictAll(3000);
    expect(session(1000).aborted).toBe(false);
    const it = read(ended);
    expect(await it.next()).toEqual({ done: false, value: 1 });
    expect(session(1000).aborted).toBe(false);
    await it.next();
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(session(1000).aborted).toBe(true);

    // Abandoned through return(), and through throw().
    const left = read(await callStream(c.client(BILLING, 'http://h:1001')));
    const thrown = read(await callStream(c.client(BILLING, 'http://h:1002')));
    await evictAll(4000);
    expect(await left.return!()).toEqual({ done: true, value: undefined });
    expect(session(1001).aborted).toBe(true);
    await expect(thrown.throw!(new Error('consumer quit'))).rejects.toThrow('consumer quit');
    expect(session(1002).aborted).toBe(true);
    // Released once: a second return() changes nothing.
    await left.return!('again');

    // Fails mid-stream.
    const broken = read(await callStream(c.client(BILLING, 'http://h:1003')));
    await evictAll(5000);
    fail = true;
    await expect(broken.next()).rejects.toThrow('stream broke');
    expect(session(1003).aborted).toBe(true);
    c.close();
  });

  it('releases a stream dropped unread at its abort or its deadline', async () => {
    const message: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
    const node = fakeNode(() => Promise.resolve({ message }));
    const { clients: c } = clients({}, node);
    const session = (port: number) => node.sessions.find((s) => s.url === `http://h:${port}`)!;
    const open = (port: number, signal: AbortSignal | undefined, timeoutMs?: number) => {
      const { transport } = c.client(
        BILLING,
        `http://h:${port}`,
        timeoutMs === undefined ? {} : { timeoutMs },
      ) as {
        transport: ClientTransportLike;
      };
      return transport.stream({}, signal, undefined, undefined, (async function* () {})());
    };
    const aborts = new AbortController();
    const spy = vi.spyOn(aborts.signal, 'removeEventListener');
    await open(1000, aborts.signal); // never iterated
    await open(1001, AbortSignal.abort()); // aborted before the headers came back
    await open(1002, undefined, 30); // the client's deadline
    for (let i = 0; i < MAX_CLIENT_ORIGINS; i++)
      await call(c.client(BILLING, `http://h:${2000 + i}`));
    expect(session(1000).aborted).toBe(false);
    expect(session(1001).aborted).toBe(true);
    expect(session(1002).aborted).toBe(false);
    aborts.abort();
    expect(session(1000).aborted).toBe(true);
    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function));
    await new Promise((ok) => setTimeout(ok, 60));
    expect(session(1002).aborted).toBe(true);
    c.close();
  });

  it('holds a stream with no deadline until it ends, never on a timer', async () => {
    const message: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
    const node = fakeNode(() => Promise.resolve({ message }));
    const { clients: c } = clients({}, node);
    const session = (port: number) => node.sessions.find((s) => s.url === `http://h:${port}`)!;
    const open = (port: number, timeoutMs: number) => {
      const { transport } = c.client(BILLING, `http://h:${port}`) as {
        transport: ClientTransportLike;
      };
      return transport.stream({}, undefined, timeoutMs, undefined, (async function* () {})());
    };
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const streams = [await open(1000, 0), await open(1001, -1)] as Array<{
      message: AsyncIterable<unknown>;
    }>;
    // No release timer was armed for either (Node would warn at a negative delay).
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
    for (let i = 0; i < MAX_CLIENT_ORIGINS; i++)
      await call(c.client(BILLING, `http://h:${2000 + i}`));
    await new Promise((ok) => setTimeout(ok, 20));
    expect(session(1000).aborted).toBe(false);
    expect(session(1001).aborted).toBe(false);
    for (const stream of streams) await stream.message[Symbol.asyncIterator]().return!();
    expect(session(1000).aborted).toBe(true);
    expect(session(1001).aborted).toBe(true);
    c.close();
  });

  it('passes return() and throw() through to the stream underneath', async () => {
    const seen: string[] = [];
    const message: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: 1 }),
        return: (value?: unknown) => {
          seen.push('return');
          return Promise.resolve({ done: true, value });
        },
        throw: () => {
          seen.push('throw');
          return Promise.resolve({ done: true, value: 'handled' });
        },
      }),
    };
    const node = fakeNode(() => Promise.resolve({ message }));
    const { clients: c } = clients({}, node);
    const response = (await callStream(c.client(BILLING, 'http://h:1'))) as {
      message: AsyncIterable<unknown>;
    };
    const it = response.message[Symbol.asyncIterator]();
    expect(await it.return!('v')).toEqual({ done: true, value: 'v' });
    expect(await it.throw!(new Error('x'))).toEqual({ done: true, value: 'handled' });
    expect(seen).toEqual(['return', 'throw']);
  });

  it('releases a stream response with no message iterable at once', async () => {
    const node = fakeNode(() => Promise.resolve({ stream: true }));
    const { clients: c } = clients({}, node);
    await callStream(c.client(BILLING, 'http://h:1000'));
    for (let i = 0; i < MAX_CLIENT_ORIGINS; i++)
      await callStream(c.client(BILLING, `http://h:${2000 + i}`));
    expect(node.sessions.find((s) => s.url === 'http://h:1000')!.aborted).toBe(true);
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

/** The refused-stream reset text connect-node writes when it reads the code. */
const RESET_TEXT = 'http/2 stream closed with error code REFUSED_STREAM (0x7)';

/**
 * A ConnectError-shaped error with that text: connect-node's local reading
 * carries no metadata; one a server sent carries the response headers.
 */
function connectNodeReading(
  metadata: Headers = new Headers(),
  rawMessage: string = RESET_TEXT,
): Error {
  return Object.assign(new FakeUnavailableError(`[unavailable] ${rawMessage}`), {
    rawMessage,
    metadata,
  });
}

describe('refused streams (REFUSED_STREAM)', () => {
  it.each([
    ['Node stream error in the cause chain', nodeRefusal(), true],
    ["connect-node's reset-code reading", connectNodeReading(), true],
    [
      'the same text sent by a server (it carries response headers)',
      connectNodeReading(new Headers({ 'content-type': 'application/proto' })),
      false,
    ],
    [
      'the text inside a longer server message',
      connectNodeReading(new Headers(), `downstream said: ${RESET_TEXT}`),
      false,
    ],
    [
      'the text with no metadata at all',
      Object.assign(new Error(`[unavailable] ${RESET_TEXT}`), { rawMessage: RESET_TEXT }),
      false,
    ],
    ['the text as a plain message', new Error(RESET_TEXT), false],
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

    // A URL target is named by its origin, never its path.
    const { clients: d } = clients(
      {},
      fakeNode(() => Promise.reject(nodeRefusal())),
    );
    const named = (await call(d.client(BILLING, 'http://h:1/secret-path')).catch(
      (e: unknown) => e,
    )) as Error;
    expect(named.message).toBe('"http://h:1" refused the call before processing it');
    expect(discovery.reports).toEqual([
      ['a', 'failure'],
      ['a', 'failure'],
    ]);
  });

  it("keeps connect-node's own Unavailable reading as is, and fails the retry with a different error as that error", async () => {
    const reading = connectNodeReading();
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

describe('review fixes (M139b)', () => {
  it('a discovery backend failure rejects as Unavailable, keeping the cause', async () => {
    const backend = new Error('consul: connection refused');
    const discovery = { pick: () => Promise.reject(backend) } as unknown as IServiceDiscovery;
    const { clients: c, node } = clients({ discovery: () => discovery });
    const error = (await call(c.client(BILLING, 'billing')).catch((e: unknown) => e)) as Error;
    expect(error).toEqual(new FakeUnavailableError('could not resolve "billing"'));
    expect(node.built).toHaveLength(0);
  });

  it(`keeps at most ${MAX_CLIENTS_PER_DEFINITION} clients per definition, evicting the least recently used`, () => {
    const { clients: c } = clients();
    const first = c.client(BILLING, 'http://t0:1');
    const second = c.client(BILLING, 'http://t1:1');
    for (let i = 2; i < MAX_CLIENTS_PER_DEFINITION; i++) c.client(BILLING, `http://t${i}:1`);
    expect(c.client(BILLING, 'http://t0:1')).toBe(first); // a hit: now the most recent
    c.client(BILLING, `http://t${MAX_CLIENTS_PER_DEFINITION}:1`); // one past the bound
    expect(c.client(BILLING, 'http://t0:1')).toBe(first);
    expect(c.client(BILLING, 'http://t1:1')).not.toBe(second); // evicted, so rebuilt
  });

  it('retries a refused call with what is left of its deadline, and not at all once it is spent', async () => {
    let now = 1000;
    const results: Array<() => Promise<unknown>> = [
      () => {
        now += 30;
        return Promise.reject(nodeRefusal());
      },
      () => Promise.resolve('ok'),
    ];
    const node = fakeNode(() => results.shift()!());
    const { clients: c } = clients({ clock: () => now }, node);
    expect(await call(c.client(BILLING, 'http://h:1'), undefined, 100)).toBe('ok');
    expect(node.built[0]!.calls.map((x) => x.timeoutMs)).toEqual([100, 70]);

    const spent = fakeNode(() => {
      now += 200;
      return Promise.reject(nodeRefusal());
    });
    const { clients: d } = clients({ clock: () => now }, spent);
    const error = await call(d.client(BILLING, 'http://h:1'), undefined, 100).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FakeUnavailableError);
    expect(spent.built[0]!.calls).toHaveLength(1);

    const unbounded = fakeNode(() =>
      results.length > 0 ? results.shift()!() : Promise.resolve('ok'),
    );
    results.push(() => Promise.reject(nodeRefusal()));
    const { clients: e } = clients({ clock: () => now }, unbounded);
    expect(await call(e.client(BILLING, 'http://h:1'))).toBe('ok');
    // No per-call deadline: the configured one the transport applied, less what was used.
    expect(unbounded.built[0]!.calls.map((x) => x.timeoutMs)).toEqual([
      undefined,
      CLIENT_DEFAULTS.timeoutMs,
    ]);

    const configured = fakeNode(() =>
      results.length > 0 ? results.shift()!() : Promise.resolve('ok'),
    );
    results.push(() => {
      now += 30;
      return Promise.reject(nodeRefusal());
    });
    const { clients: f } = clients({ clock: () => now }, configured);
    expect(await call(f.client(BILLING, 'http://h:1', { timeoutMs: 500 }))).toBe('ok');
    expect(configured.built[0]!.calls.map((x) => x.timeoutMs)).toEqual([undefined, 470]);

    const configuredSpent = fakeNode(() => {
      now += 600;
      return Promise.reject(nodeRefusal());
    });
    const { clients: g } = clients({ clock: () => now }, configuredSpent);
    await expect(call(g.client(BILLING, 'http://h:1', { timeoutMs: 500 }))).rejects.toBeInstanceOf(
      FakeUnavailableError,
    );
    expect(configuredSpent.built[0]!.calls).toHaveLength(1);

    // timeoutMs <= 0 is Connect's "no deadline": retried with none, however long it took.
    for (const none of [0, -1]) {
      const noDeadline = fakeNode(() =>
        results.length > 0 ? results.shift()!() : Promise.resolve('ok'),
      );
      results.push(() => {
        now += 10_000;
        return Promise.reject(nodeRefusal());
      });
      const { clients: h } = clients({ clock: () => now }, noDeadline);
      expect(await call(h.client(BILLING, 'http://h:1'), undefined, none)).toBe('ok');
      expect(noDeadline.built[0]!.calls.map((x) => x.timeoutMs)).toEqual([none, none]);
    }
  });
});
