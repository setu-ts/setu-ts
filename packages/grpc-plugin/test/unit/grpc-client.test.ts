import { describe, expect, it, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { CAPABILITIES, UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN } from '@setu-ts/common';
import type {
  GrpcClientOptions,
  GrpcServiceDefinition,
  IGrpcService,
  IServiceDiscovery,
  IServiceRegistry,
  ITelemetryService,
  ServiceInstance,
} from '@setu-ts/common';

import {
  CLIENT_DEFAULTS,
  CLIENT_IDLE_TIMEOUT_MS,
  CLIENT_MAX_SESSION_MEMORY_MB,
  GrpcClients,
  instanceOrigin,
  MAX_CLIENT_ORIGINS,
  MAX_CLIENTS_PER_DEFINITION,
  targetBase,
  validateClientOptions,
  WORKERS_REFUSAL,
} from '../../src/client/grpc-client.ts';
import type { GrpcClientDeps } from '../../src/client/grpc-client.ts';
import { isRefusedStream } from '../../src/client/call-outcome.ts';
import { PeerHeaderListLimitError } from '../../src/client/header-list-guard.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { grpcClient } from '../../src/client/grpc-client-helper.ts';
import {
  CONNECT_NODE_SPECIFIER,
  importConnectNode,
  loadConnectNode,
} from '../../src/client/connect-node-loader.ts';
import type { ConnectNodeModuleLike } from '../../src/client/connect-node-loader.ts';
import { GrpcExcessiveLoadError, GrpcRuntimeLoadError } from '../../src/errors/grpc-errors.ts';
import type { ClientTransportLike } from '../../src/interfaces/connect-runtime.ts';
import { GrpcService } from '../../src/services/grpc-service.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';
import {
  createFakeConnectRuntime,
  FakeResourceExhaustedError,
  FakeUnavailableError,
} from '../fixtures/fake-connect-runtime.ts';

const BILLING: GrpcServiceDefinition = { typeName: 'billing.v1.BillingService', method: {} };

describe('unprocessed shutdown answers', () => {
  const marked = (wire: boolean) => {
    const error = Object.assign(new FakeUnavailableError('draining'), { isWireError: wire });
    error.metadata.set(UNPROCESSED_HEADER, UNPROCESSED_SHUTDOWN);
    return error;
  };
  for (const stop of ['abort', 'deadline', 'unbounded abort'] as const) {
    for (const late of ['resolve', 'reject'] as const) {
      it(`settles a pending retry pick on ${stop} before its late ${late}`, async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const refusal = marked(true);
        const discovery = fakeDiscovery([instance('first', 1)]);
        let picks = 0;
        let finish!: (found: ServiceInstance) => void;
        let fail!: (error: Error) => void;
        const picking = new Promise<ServiceInstance>((yes, no) => {
          finish = yes;
          fail = no;
        });
        discovery.pick = () => (++picks === 1 ? Promise.resolve(instance('first', 1)) : picking);
        let sends = 0;
        const { clients: c } = clients(
          { discovery: () => discovery, clock: () => performance.now() },
          fakeNode(() => {
            sends++;
            return Promise.reject(refusal);
          }),
        );
        const client = c.client(BILLING, 'billing') as { transport: ClientTransportLike };
        let settled = false;
        let result: unknown;
        const pending = client.transport
          .unary({}, controller.signal, stop === 'unbounded abort' ? 0 : 100, undefined, {})
          .catch((error: unknown) => {
            settled = true;
            result = error;
          });
        try {
          for (let n = 0; n < 50; n++) await Promise.resolve();
          expect(picks).toBe(2);
          if (stop === 'deadline') await vi.advanceTimersByTimeAsync(100);
          else controller.abort(new Error('caller stopped'));
          for (let n = 0; n < 50; n++) await Promise.resolve();
          expect(settled).toBe(true);
          expect(result).toBe(refusal);
          if (late === 'resolve') finish(instance('late', 2));
          else fail(new Error('late pick failure'));
          await pending;
          for (let n = 0; n < 50; n++) await Promise.resolve();
          expect(sends).toBe(1);
          expect(discovery.reports).toEqual([['first', 'failure']]);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          finish(instance('cleanup', 2));
          await pending;
          c.close();
          vi.useRealTimers();
        }
      });
    }
  }
  it('preserves the first refusal when retry setup rejects after the budget', async () => {
    let now = 0;
    const refusal = marked(false);
    const discovery = fakeDiscovery([instance('first', 1)]);
    let picks = 0;
    discovery.pick = () => {
      if (++picks === 1) return Promise.resolve(instance('first', 1));
      now = 101;
      return Promise.reject(new Error('late resolution failure'));
    };
    const { clients: c } = clients(
      { discovery: () => discovery, clock: () => now },
      fakeNode(() => Promise.reject(refusal)),
    );
    try {
      await expect(call(c.client(BILLING, 'billing'), undefined, 100)).rejects.toBe(refusal);
      expect(discovery.reports).toEqual([['first', 'failure']]);
    } finally {
      c.close();
    }
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 3e9])(
    'resends marked Unavailable when the per-call timeout is out of timer range (%s)',
    async (timeoutMs) => {
      const discovery = fakeDiscovery([instance('draining', 1), instance('live', 2)]);
      let attempts = 0;
      const node = fakeNode(() =>
        ++attempts === 1 ? Promise.reject(marked(false)) : Promise.resolve('ok'),
      );
      const { clients: c } = clients({ discovery: () => discovery }, node);
      try {
        expect(await call(c.client(BILLING, 'billing'), undefined, timeoutMs)).toBe('ok');
        expect(attempts).toBe(2);
      } finally {
        c.close();
      }
    },
  );
  it.each([false, true])(
    'resends marked Unavailable once on a new pick with the remaining deadline (wire=%s)',
    async (wire) => {
      const discovery = fakeDiscovery([instance('draining', 1), instance('live', 2)]);
      let now = 0;
      let attempts = 0;
      const error = marked(wire);
      const node = fakeNode(() => {
        if (++attempts === 1) {
          now = 25.2;
          return Promise.reject(error);
        }
        return Promise.resolve('ok');
      });
      const { clients: c } = clients({ discovery: () => discovery, clock: () => now }, node);
      expect(await call(c.client(BILLING, 'billing'), undefined, 100)).toBe('ok');
      expect(attempts).toBe(2);
      expect(
        node.built.map((built) => [built.options['baseUrl'], built.calls[0]!.timeoutMs]),
      ).toEqual([
        ['http://127.0.0.1:1', 100],
        ['http://127.0.0.1:2', 74],
      ]);
      expect(discovery.reports).toEqual([
        ['draining', 'failure'],
        ['live', 'success'],
      ]);
    },
  );
  it.each(['missing', 'other value', 'other code', 'stream'] as const)(
    'does not resend %s',
    async (kind) => {
      const error = kind === 'other code' ? new FakeResourceExhaustedError('busy') : marked(true);
      if (kind === 'missing') error.metadata.delete(UNPROCESSED_HEADER);
      else
        error.metadata.set(
          UNPROCESSED_HEADER,
          kind === 'other value' ? 'Shutdown' : UNPROCESSED_SHUTDOWN,
        );
      let attempts = 0;
      const node = fakeNode(() => {
        attempts++;
        return Promise.reject(error);
      });
      const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
      const { clients: c } = clients({ discovery: () => discovery }, node);
      const client = c.client(BILLING, 'billing');
      await expect(kind === 'stream' ? callStream(client) : call(client)).rejects.toBe(error);
      expect(attempts).toBe(1);
      expect(discovery.reports).toHaveLength(1);
    },
  );
  it('surfaces the second marked error without a third send', async () => {
    const errors = [marked(false), marked(true)];
    let attempts = 0;
    const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
    const { clients: c } = clients(
      { discovery: () => discovery },
      fakeNode(() => Promise.reject(errors[attempts++])),
    );
    await expect(call(c.client(BILLING, 'billing'))).rejects.toBe(errors[1]);
    expect(attempts).toBe(2);
    expect(discovery.reports).toEqual([
      ['a', 'failure'],
      ['b', 'failure'],
    ]);
  });
  it('does not resend after the deadline is spent', async () => {
    let now = 0;
    let attempts = 0;
    const error = marked(false);
    const { clients: c } = clients(
      { clock: () => now },
      fakeNode(() => {
        attempts++;
        now = 100;
        return Promise.reject(error);
      }),
    );
    await expect(call(c.client(BILLING, 'http://h:1'), undefined, 100)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
  it('does not resend when the caller aborts between the refusal and the resend', async () => {
    const controller = new AbortController();
    let reads = 0;
    let attempts = 0;
    const error = marked(false);
    const { clients: c } = clients(
      {
        clock: () => {
          if (++reads === 2) controller.abort();
          return 0;
        },
      },
      fakeNode(() => {
        attempts++;
        return Promise.reject(error);
      }),
    );
    const client = c.client(BILLING, 'http://h:1') as { transport: ClientTransportLike };
    await expect(client.transport.unary({}, controller.signal, 100, undefined, {})).rejects.toBe(
      error,
    );
    expect(attempts).toBe(1);
  });
  it('does not send if the caller aborts while the resend is picking an instance', async () => {
    const controller = new AbortController();
    const error = marked(true);
    let attempts = 0;
    const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
    const pick = discovery.pick.bind(discovery);
    let picks = 0;
    discovery.pick = (name, options) => {
      if (++picks === 2) controller.abort();
      return pick(name, options);
    };
    const { clients: c } = clients(
      { discovery: () => discovery },
      fakeNode(() => {
        attempts++;
        return Promise.reject(error);
      }),
    );
    const client = c.client(BILLING, 'billing') as { transport: ClientTransportLike };
    await expect(client.transport.unary({}, controller.signal, 100, undefined, {})).rejects.toBe(
      error,
    );
    expect(picks).toBe(2);
    expect(attempts).toBe(1);
    expect(discovery.reports).toEqual([['a', 'failure']]);
  });
});

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
  pingOptionsSeen: Array<Record<string, unknown> | undefined>;
  /** Each session's `state()`, by URL; absent reads as `'idle'`, `'throw'` throws. */
  states: Map<string, string>;
  /** How many times any session's `state()` was read. */
  stateReads: { count: number };
  /** A call to a base URL here waits on its promise before answering. */
  gates: Map<string, Promise<unknown>>;
} {
  const built: Built[] = [];
  const sessions: Array<{ url: string; aborted: boolean }> = [];
  const sessionOptionsSeen: Array<Record<string, unknown> | undefined> = [];
  const pingOptionsSeen: Array<Record<string, unknown> | undefined> = [];
  const states = new Map<string, string>();
  const stateReads = { count: 0 };
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
    pingOptionsSeen,
    states,
    stateReads,
    gates,
    module: {
      createConnectTransport: factory('connect'),
      createGrpcTransport: factory('grpc'),
      createGrpcWebTransport: factory('grpc-web'),
      Http2SessionManager: class {
        readonly #entry: { url: string; aborted: boolean };
        // connect-node's arity: (url, pingOptions?, http2SessionOptions?).
        constructor(url: string, ...rest: [Record<string, unknown>?, Record<string, unknown>?]) {
          this.#entry = { url, aborted: false };
          sessions.push(this.#entry);
          pingOptionsSeen.push(rest[0]);
          sessionOptionsSeen.push(rest[1]);
        }
        abort(): void {
          this.#entry.aborted = true;
        }
        request(): Promise<never> {
          return Promise.reject(new Error('the fake transport never opens a stream'));
        }
        state(): string {
          stateReads.count++;
          const state = states.get(this.#entry.url) ?? 'idle';
          if (state === 'throw') throw new Error('state unreadable');
          return state;
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

  it('reads an option set to undefined as not set, per target and per call', async () => {
    // JavaScript, or options built from optional configuration, can carry the key.
    const unset = { basePath: undefined, timeoutMs: undefined } as unknown as GrpcClientOptions;
    const { clients: c, node } = clients({
      targets: { 'http://h:1': { ...unset, protocol: 'grpc-web' } as GrpcClientOptions },
    });
    await call(c.client(BILLING, 'http://h:1', unset));
    expect(node.built[0]!.kind).toBe('grpc-web');
    expect(node.built[0]!.options).toMatchObject({
      baseUrl: 'http://h:1',
      defaultTimeoutMs: 5000,
    });
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
    fail = Object.assign(new FakeUnavailableError('refused'), {
      cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
    });
    await expect(call(client)).rejects.toBe(fail);
    fail = Object.assign(new Error('InvalidArgument from the server'), {
      code: 3,
      isWireError: true,
    });
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

  /** A gate a test opens by hand. */
  const gate = (): { promise: Promise<void>; open: () => void } => {
    let open!: () => void;
    const promise = new Promise<void>((ok) => (open = ok));
    return { promise, open };
  };

  it(`keeps at most ${MAX_CLIENT_ORIGINS} origins, forgetting the least recently used`, async () => {
    const { clients: c, node } = clients();
    const first = c.client(BILLING, 'http://h:1000');
    await call(first);
    for (let port = 1; port < MAX_CLIENT_ORIGINS; port++)
      await call(c.client(BILLING, `http://h:${1000 + port}`));
    await call(first); // used again: now the most recent
    await call(c.client(BILLING, `http://h:${1000 + MAX_CLIENT_ORIGINS}`));
    expect(c.originCount).toBe(MAX_CLIENT_ORIGINS);
    // h:1001 was forgotten, not closed: connect-node closes it once idle.
    expect(node.sessions.filter((s) => s.aborted)).toEqual([]);
    expect(
      node.pingOptionsSeen.every((o) => o?.['idleConnectionTimeoutMs'] === CLIENT_IDLE_TIMEOUT_MS),
    ).toBe(true);
    await call(c.client(BILLING, 'http://h:1001')); // a new session for it
    expect(node.sessions.filter((s) => s.url === 'http://h:1001')).toHaveLength(2);
    c.close();
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
  });

  it('never closes an evicted session, whatever is on it; close() closes them all', async () => {
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
    // Started before connect-node loads, and on into the next turn, with calls held open.
    for (let port = 0; port < MAX_CLIENT_ORIGINS * 3; port++) {
      node.gates.set(`http://h:${1000 + port}`, held.promise);
      busy.push(call(c.client(BILLING, `http://h:${1000 + port}`)));
    }
    loaded.open();
    await new Promise((ok) => setTimeout(ok, 0));
    // A busy one (h:1000) and one whose current connection reads idle while an
    // older one finishes a call (h:1001): the client can tell neither, and closes neither.
    node.states.set('http://h:1001', 'idle');
    for (let port = 0; port < MAX_CLIENT_ORIGINS; port++)
      await call(c.client(BILLING, `http://h:${5000 + port}`));
    expect(node.sessions).toHaveLength(MAX_CLIENT_ORIGINS * 4);
    expect(node.sessions.filter((s) => s.aborted)).toEqual([]);
    c.close();
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
    held.open();
    await Promise.all(busy);
  });

  it('drops an evicted session only once it has had the idle bound to close', async () => {
    let now = 0;
    const { clients: c, node } = clients({ clock: () => now });
    for (let port = 0; port < MAX_CLIENT_ORIGINS + 3; port++)
      await call(c.client(BILLING, `http://h:${1000 + port}`));
    // h:1000–h:1002 are evicted at 0: connect-node closes one, errors one, one stays connected.
    node.states.set('http://h:1000', 'closed');
    node.states.set('http://h:1001', 'error');
    node.states.set('http://h:1002', 'open');
    now = CLIENT_IDLE_TIMEOUT_MS - 1;
    await call(c.client(BILLING, 'http://h:3000')); // too young to look at
    now = CLIENT_IDLE_TIMEOUT_MS;
    node.states.set('http://h:1003', 'closed'); // evicted by the last call: too young to look at
    await call(c.client(BILLING, 'http://h:3001')); // drops h:1000, h:1001; keeps h:1002
    now = CLIENT_IDLE_TIMEOUT_MS * 2 - 2;
    node.states.set('http://h:1002', 'closed');
    await call(c.client(BILLING, 'http://h:3002')); // h:1002 was re-queued at the bound: too young
    c.close();
    const aborted = new Set(node.sessions.filter((s) => s.aborted).map((s) => s.url));
    expect(aborted.has('http://h:1000')).toBe(false);
    expect(aborted.has('http://h:1001')).toBe(false);
    expect(aborted.has('http://h:1002')).toBe(true);
    expect(aborted.has('http://h:1003')).toBe(true);
  });

  it('looks at each evicted session once per idle bound, not once per eviction', async () => {
    let now = 0;
    const { clients: c, node } = clients({ clock: () => now });
    for (let port = 0; port < MAX_CLIENT_ORIGINS; port++)
      await call(c.client(BILLING, `http://h:${1000 + port}`));
    // Every evicted session stays connected; 400 evictions, one per second.
    for (let i = 0; i < 400; i++) {
      now = i * 1000;
      await call(c.client(BILLING, `http://h:${2000 + i}`));
    }
    // The one evicted at i s is looked at 60 s later and every 60 s after, up to 399 s.
    let looks = 0;
    for (let i = 0; i < 400; i++) looks += Math.floor((399 - i) / 60);
    expect(node.stateReads.count).toBe(looks);
    c.close();
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
  });

  it('stops the scan at the first evicted session too young to look at', async () => {
    let now = 0;
    const { clients: c, node } = clients({ clock: () => now });
    for (let port = 0; port < MAX_CLIENT_ORIGINS; port++)
      await call(c.client(BILLING, `http://h:${1000 + port}`));
    // 40,000 evictions inside one bound: a scan past the young entries would be quadratic.
    const started = performance.now();
    for (let i = 0; i < 40_000; i++) {
      now = i;
      await call(c.client(BILLING, `http://h:${10_000 + i}`));
    }
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(node.stateReads.count).toBe(0);
    c.close();
  });

  it('keeps every evicted session when the clock is not a finite reading', async () => {
    for (const reading of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { clients: c, node } = clients({ clock: () => reading });
      for (let port = 0; port < MAX_CLIENT_ORIGINS + 5; port++) {
        node.states.set(`http://h:${1000 + port}`, 'closed');
        await call(c.client(BILLING, `http://h:${1000 + port}`));
      }
      expect(node.stateReads.count).toBe(0);
      c.close();
      expect(node.sessions.every((s) => s.aborted)).toBe(true);
    }
  });

  it('reads an evicted session whose state() throws as still connected', async () => {
    let now = 0;
    const { clients: c, node } = clients({ clock: () => now });
    for (let port = 0; port < MAX_CLIENT_ORIGINS + 1; port++)
      await call(c.client(BILLING, `http://h:${1000 + port}`));
    node.states.set('http://h:1000', 'throw');
    now = CLIENT_IDLE_TIMEOUT_MS;
    await call(c.client(BILLING, 'http://h:3000'));
    expect(node.stateReads.count).toBe(1);
    c.close();
    expect(node.sessions.every((s) => s.aborted)).toBe(true);
  });

  it('reaches sessions looked up while connect-node loads and connected after their eviction', async () => {
    const loaded = gate();
    const node = fakeNode();
    const { clients: c } = clients(
      {
        clock: () => 0,
        loadNode: async () => {
          await loaded.promise;
          return node.module;
        },
      },
      node,
    );
    const held = gate();
    const busy: Array<Promise<unknown>> = [];
    for (let port = 0; port < MAX_CLIENT_ORIGINS * 2 + 2; port++) {
      const url = `http://h:${1000 + port}`;
      // Not yet connected when evicted: connect-node reads such a session `closed` too.
      node.states.set(url, 'closed');
      node.gates.set(url, held.promise);
      busy.push(call(c.client(BILLING, url)));
    }
    loaded.open();
    await new Promise((ok) => setTimeout(ok, 0));
    c.close();
    expect(node.sessions.filter((s) => !s.aborted).map((s) => s.url)).toEqual([]);
    held.open();
    await Promise.all(busy);
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
      'Cannot load Connect runtime module: @connectrpc/connect-node. Run: deno add npm:@connectrpc/connect-node@^2.2.0 · npm i @connectrpc/connect-node · bun add @connectrpc/connect-node',
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
  it('resends an undersized header-limit refusal once and preserves size and limit if both picks refuse', async () => {
    const real = await loadConnectModule();
    for (const succeeds of [true, false]) {
      const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
      const local = new PeerHeaderListLimitError(8192, 1024);
      const wrapped = ConnectError.from(local, Code.Internal);
      expect(wrapped.cause).toBe(local);
      let attempts = 0;
      const node = fakeNode(() => {
        attempts++;
        return succeeds && attempts === 2 ? Promise.resolve('ok') : Promise.reject(wrapped);
      });
      const { clients: c } = clients(
        {
          discovery: () => discovery,
          runtime: { ...createFakeConnectRuntime(), unavailable: real.unavailable },
        },
        node,
      );
      const result: unknown = await call(c.client(BILLING, 'billing')).catch((e: unknown) => e);
      expect(attempts).toBe(2);
      expect(discovery.reports).toEqual([
        ['a', 'failure'],
        ['b', succeeds ? 'success' : 'failure'],
      ]);
      if (succeeds) expect(result).toBe('ok');
      else {
        expect(result).toBeInstanceOf(ConnectError);
        expect((result as ConnectError).code).toBe(Code.Unavailable);
        expect((result as ConnectError).rawMessage).toBe(local.message);
        expect((result as Error).cause).toBe(wrapped);
      }
    }
  });

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

  it('neither reports nor resends a call the server reset with ENHANCE_YOUR_CALM, and names it', async () => {
    const calm = Object.assign(
      new Error('Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'),
      {
        code: 'ERR_HTTP2_STREAM_ERROR',
      },
    );
    for (const shape of [calm, new Error('[internal] reset', { cause: calm })]) {
      const discovery = fakeDiscovery([instance('a', 1), instance('b', 2)]);
      let attempts = 0;
      const node = fakeNode(() => {
        attempts++;
        return Promise.reject(shape);
      });
      const { clients: c } = clients({ discovery: () => discovery }, node);
      const error = (await call(c.client(BILLING, 'billing')).catch((e: unknown) => e)) as Error & {
        cause?: unknown;
      };
      expect(attempts).toBe(1);
      expect(discovery.reports).toEqual([]);
      expect(error).toBeInstanceOf(FakeResourceExhaustedError);
      expect(error.cause).toBeInstanceOf(GrpcExcessiveLoadError);
      expect(error.message).toBe((error.cause as Error).message);
      expect((error.cause as Error & { cause?: unknown }).cause).toBe(shape);
      expect(isRefusedStream(error)).toBe(false);
    }
  });

  it('a wire error copying the ENHANCE_YOUR_CALM text follows the normal outcome rule', async () => {
    const discovery = fakeDiscovery([instance('a', 1)]);
    const copied = Object.assign(
      new Error('Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'),
      {
        code: 'ERR_HTTP2_STREAM_ERROR',
        isWireError: true,
      },
    );
    const node = fakeNode(() => Promise.reject(copied));
    const { clients: c } = clients({ discovery: () => discovery }, node);
    expect(await call(c.client(BILLING, 'billing')).catch((e: unknown) => e)).toBe(copied);
    expect(discovery.reports).toEqual([['a', 'failure']]);
  });

  it('a caller abort during an ENHANCE_YOUR_CALM reset rethrows the original error', async () => {
    const discovery = fakeDiscovery([instance('a', 1)]);
    const calm = Object.assign(
      new Error('Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'),
      {
        code: 'ERR_HTTP2_STREAM_ERROR',
      },
    );
    const abort = new AbortController();
    const node = fakeNode(() => {
      abort.abort();
      return Promise.reject(calm);
    });
    const { clients: c } = clients({ discovery: () => discovery }, node);
    const { transport } = c.client(BILLING, 'billing') as { transport: ClientTransportLike };
    const error = await transport
      .unary({}, abort.signal, undefined, undefined, {})
      .catch((e: unknown) => e);
    expect(error).toBe(calm);
    expect(discovery.reports).toEqual([]);
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

it('reports unary deadline failure, omits caller abort, and reports streaming success only at headers', async () => {
  const discovery = fakeDiscovery([instance('a', 8080)]);
  let error: unknown = Object.assign(new Error('deadline'), { code: 4 });
  const node = fakeNode(() => Promise.reject(error));
  const { clients: clientSet } = clients({ discovery: () => discovery }, node);
  const client = clientSet.client(BILLING, 'billing');
  await expect(call(client)).rejects.toBe(error);
  expect(discovery.reports).toEqual([['a', 'failure']]);
  discovery.reports.length = 0;
  const abort = new AbortController();
  abort.abort();
  const transport = (client as { transport: ClientTransportLike }).transport;
  error = Object.assign(new Error('canceled'), { code: 1 });
  await expect(transport.unary({}, abort.signal, undefined, undefined, {})).rejects.toBe(error);
  expect(discovery.reports).toEqual([]);
  clientSet.close();
  const streaming = clients(
    { discovery: () => discovery },
    fakeNode(() =>
      Promise.resolve({
        message: {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('late deadline')),
          }),
        },
      }),
    ),
  );
  const result = (await callStream(streaming.clients.client(BILLING, 'billing'))) as {
    message: AsyncIterable<unknown>;
  };
  await expect(result.message[Symbol.asyncIterator]().next()).rejects.toThrow('late deadline');
  expect(discovery.reports).toEqual([['a', 'success']]);
  streaming.clients.close();
});

it('does not resend an unmarked drain 503', async () => {
  let calls = 0;
  const discovery = fakeDiscovery([instance('a', 8080), instance('b', 8081)]);
  const error = Object.assign(new FakeUnavailableError('HTTP 503'), {
    metadata: new Headers({ 'content-type': 'text/plain' }),
  });
  const { clients: clientSet } = clients(
    { discovery: () => discovery },
    fakeNode(() => {
      calls++;
      return Promise.reject(error);
    }),
  );
  await expect(call(clientSet.client(BILLING, 'billing'))).rejects.toBe(error);
  expect(calls).toBe(1);
  expect(discovery.reports).toEqual([['a', 'failure']]);
  clientSet.close();
});

it('neither reports nor retries a caller-aborted refused stream', async () => {
  const discovery = fakeDiscovery([instance('a', 8080), instance('b', 8081)]);
  const abort = new AbortController();
  const refused = Object.assign(new Error('NGHTTP2_REFUSED_STREAM'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
  });
  let calls = 0;
  const { clients: clientSet } = clients(
    { discovery: () => discovery },
    fakeNode(() => {
      calls++;
      abort.abort();
      return Promise.reject(refused);
    }),
  );
  const client = clientSet.client(BILLING, 'billing') as { transport: ClientTransportLike };
  await expect(client.transport.unary({}, abort.signal, undefined, undefined, {})).rejects.toBe(
    refused,
  );
  expect(calls).toBe(1);
  expect(discovery.reports).toEqual([]);
  clientSet.close();
});

it('refuses an invalid caller header before picking or reporting an instance', async () => {
  const discovery = fakeDiscovery([instance('a', 8080), instance('b', 8081)]);
  let picks = 0;
  const pick = discovery.pick.bind(discovery);
  discovery.pick = (...args: Parameters<typeof pick>) => {
    picks++;
    return pick(...args);
  };
  let calls = 0;
  const { clients: clientSet } = clients(
    { discovery: () => discovery },
    fakeNode(() => {
      calls++;
      return Promise.resolve({});
    }),
  );
  const client = clientSet.client(BILLING, 'billing') as { transport: ClientTransportLike };
  for (const header of [{ 'x a': '1' }, { 'x-a': 'a\nb' }, { 'x-a': 'é€' }]) {
    await expect(
      client.transport.unary({}, undefined, undefined, header, {}),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.transport.stream({}, undefined, undefined, header, (async function* () {})()),
    ).rejects.toBeInstanceOf(TypeError);
  }
  expect(picks).toBe(0);
  expect(calls).toBe(0);
  expect(discovery.reports).toEqual([]);
  // A valid header, given as a plain object, still reaches the transport.
  await client.transport.unary({}, undefined, undefined, { 'x-a': 'ok' }, {});
  expect(calls).toBe(1);
  clientSet.close();
});

it('does not send or report a resend whose pick consumed the remaining deadline', async () => {
  const discovery = fakeDiscovery([instance('first', 1), instance('second', 2)]);
  let picks = 0;
  let now = 0;
  let sent = 0;
  const pick = discovery.pick.bind(discovery);
  discovery.pick = async (name) => {
    const found = await pick(name);
    if (++picks === 2) now = 101;
    return found;
  };
  const refusal = Object.assign(new Error('NGHTTP2_REFUSED_STREAM'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
  });
  const node = fakeNode(() => {
    sent++;
    return Promise.reject(refusal);
  });
  const { clients: c } = clients({ discovery: () => discovery, clock: () => now }, node);
  await expect(call(c.client(BILLING, 'billing'), undefined, 100)).rejects.toThrow(
    'refused the call',
  );
  expect(picks).toBe(2);
  expect(sent).toBe(1);
  expect(discovery.reports).toEqual([['first', 'failure']]);
});
