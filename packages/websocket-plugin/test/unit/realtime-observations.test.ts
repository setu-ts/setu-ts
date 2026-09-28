/**
 * M98l realtime observations for the WebSocket plugin: what each capture site
 * counts (plan §3.6), the gauges read from the plugin's OWN service, the
 * disabled path, canaries, observed-versus-unobserved parity, and teardown.
 *
 * Driven through `WebSocketPlugin(...).register(...)` over a fake context
 * whose monotonic clock is advanced by hand, so the 60-second record expiry
 * is tested without waiting.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IHttpAdapter,
  IPluginContext,
  IRealtimeDiagnosticsSource,
  IRequest,
  IResponse,
  IWebSocketConnection,
  RealtimeDiagnosticsSnapshot,
  ServerHandle,
  WebSocketEventSink,
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/plugin/websocket-plugin.ts';
import type { WebSocketPluginOptions } from '../../src/interfaces/index.ts';
import type { WebSocketService } from '../../src/services/websocket-service.ts';
import { realtimeObserverOf } from '../../src/diagnostics/realtime-observations.ts';
import {
  createFakeRuntime,
  createFakeTransport,
  type FakeRuntime,
  type FakeTransport,
  upgradeRequest,
} from '../fixtures/fake-runtime.ts';

const ENABLED = { enabled: true, alias: 'chat-hub' } as const;

interface Harness {
  readonly runtime: FakeRuntime;
  readonly service: WebSocketService;
  readonly source: IRealtimeDiagnosticsSource;
  readonly sources: unknown[];
  readonly closeHooks: (() => void)[];
  readonly router: WebSocketUpgradeRouter;
  /** Replaces the WEBSOCKET registration, as an override would. */
  replaceService(replacement: unknown): void;
}

/** Registers the plugin over a fake context and returns what it registered. */
async function setup(options?: WebSocketPluginOptions): Promise<Harness> {
  const runtime = createFakeRuntime();
  const single = new Map<string, unknown>();
  const multi = new Map<string, unknown[]>();
  const closeHooks: (() => void)[] = [];
  let router: WebSocketUpgradeRouter | null = null;
  const adapter: IHttpAdapter = {
    setHandler(_handler: (request: IRequest) => Promise<IResponse>): void {},
    setUpgradeRouter(installed: WebSocketUpgradeRouter): void {
      router = installed;
    },
    fetch: () => Promise.resolve(new Response(null)),
    listen: () => Promise.resolve({} as ServerHandle),
    close: () => Promise.resolve(),
  };
  const ctx = {
    runtime,
    services: {
      has: (token: string): boolean => token === CAPABILITIES.HTTP_ADAPTER || single.has(token),
      get: <T>(token: string): T =>
        (token === CAPABILITIES.HTTP_ADAPTER ? adapter : single.get(token)) as T,
      register: <T>(token: string, value: T, opts?: { multi?: boolean }): void => {
        if (opts?.multi === true) {
          multi.set(token, [...(multi.get(token) ?? []), value]);
        } else {
          single.set(token, value);
        }
      },
    },
    health: { register: (): void => {} },
    lifecycle: {
      onClose: (hook: () => void): void => {
        closeHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;
  await WebSocketPlugin(options).register(ctx);
  const sources = multi.get(CAPABILITIES.REALTIME_DIAGNOSTICS) ?? [];
  return {
    runtime,
    service: single.get(CAPABILITIES.WEBSOCKET) as WebSocketService,
    source: sources[0] as IRealtimeDiagnosticsSource,
    sources,
    closeHooks,
    router: router!,
    replaceService(replacement: unknown): void {
      single.set(CAPABILITIES.WEBSOCKET, replacement);
    },
  };
}

/** Accepts one upgrade on `/ws` and returns its sink. */
async function accept(harness: Harness, url = 'http://localhost/ws'): Promise<WebSocketEventSink> {
  const decision = await harness.router(upgradeRequest(url));
  if (decision === null || !decision.accept) {
    throw new Error('expected an accepted upgrade');
  }
  return decision.sink;
}

/** Opens a connection through the sink, returning its transport. */
function open(sink: WebSocketEventSink): FakeTransport {
  const transport = createFakeTransport();
  sink.onOpen(transport);
  return transport;
}

function record(snapshot: RealtimeDiagnosticsSnapshot, operation: string) {
  return snapshot.records.find((entry) => entry.operation === operation);
}

/** Routes `/ws`, capturing each opened connection. */
function route(harness: Harness): IWebSocketConnection[] {
  const opened: IWebSocketConnection[] = [];
  harness.service.route('/ws', {
    onOpen: (conn) => {
      opened.push(conn);
    },
  });
  return opened;
}

describe('WebSocketPlugin realtime observations (M98l)', () => {
  it('refuses an invalid diagnostics option when the plugin is constructed', () => {
    expect(() => WebSocketPlugin({ diagnostics: { enabled: true, alias: '' } })).toThrow(
      'Realtime diagnostics',
    );
    expect(() => WebSocketPlugin({ diagnostics: { enabled: false } as unknown as typeof ENABLED }))
      .toThrow('enabled must be the literal true');
  });

  describe('disabled by default', () => {
    it('registers one inert websocket source, attaches nothing, and counts nothing', async () => {
      const harness = await setup();
      expect(harness.sources).toHaveLength(1);
      expect(Object.keys(harness.source)).toEqual(['snapshot']);
      expect(realtimeObserverOf(harness.service)).toBeUndefined();
      const opened = route(harness);
      const transport = open(await accept(harness));
      opened[0]!.send('frame');
      expect(transport.sent).toEqual(['frame']);
      expect(realtimeObserverOf(opened[0]!)).toBeUndefined();
      expect(harness.source.snapshot()).toEqual({
        state: 'disabled',
        alias: null,
        sourceKind: 'websocket',
        coverage: 'owned-instance',
        gauges: { state: 'disabled', openConnections: null, groups: null },
        records: [],
        dropped: 0,
      });
    });

    it('never calls the service size getters on a read', async () => {
      const harness = await setup();
      let reads = 0;
      Object.defineProperty(harness.service, 'connectionCount', {
        get: () => {
          reads++;
          return 0;
        },
      });
      harness.source.snapshot();
      expect(reads).toBe(0);
    });
  });

  describe('enabled', () => {
    it('reports measured zero gauges and ready before any operation', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      expect(harness.source.snapshot()).toEqual({
        state: 'ready',
        alias: 'chat-hub',
        sourceKind: 'websocket',
        coverage: 'owned-instance',
        gauges: { state: 'available', openConnections: 0, groups: 0 },
        records: [],
        dropped: 0,
      });
    });

    it('counts a send once at the connection: direct, sendJson, room broadcast and heartbeat', async () => {
      const harness = await setup({ diagnostics: ENABLED, heartbeatMs: 1_000 });
      const opened = route(harness);
      open(await accept(harness));
      const conn = opened[0]!;
      conn.send('a');
      conn.sendJson({ b: 1 });
      harness.service.room('lobby').add(conn);
      harness.service.room('lobby').broadcast('c');
      harness.runtime.runIntervals();
      expect(record(harness.source.snapshot(), 'send')).toMatchObject({
        count: 4,
        succeeded: 4,
        failed: 0,
        backpressureCloses: null,
        lastDurationMs: null,
      });
      expect(record(harness.source.snapshot(), 'open')).toMatchObject({ count: 1, succeeded: 1 });
    });

    it('counts a refused send as failed and rethrows the SAME error', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const opened = route(harness);
      const transport = open(await accept(harness));
      const conn = opened[0]!;
      const boom = new Error('transport refused');
      transport.send = (): void => {
        throw boom;
      };
      let caught: unknown;
      try {
        conn.send('x');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(boom);
      conn.close(1000);
      expect(() => conn.send('y')).toThrow('it is not open');
      expect(record(harness.source.snapshot(), 'send')).toMatchObject({
        count: 2,
        succeeded: 0,
        failed: 2,
      });
    });

    it('a normal close succeeds; 1006 and a close after a transport error fail', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      route(harness);
      const normal = await accept(harness);
      open(normal);
      normal.onClose({ code: 1000, reason: '' });
      const abnormal = await accept(harness);
      open(abnormal);
      abnormal.onClose({ code: 1006, reason: '' });
      const errored = await accept(harness);
      open(errored);
      errored.onError(new Error('CANARY-transport-error'));
      errored.onClose({ code: 1000, reason: '' });
      const tooBig = await accept(harness);
      open(tooBig);
      tooBig.onClose({ code: 1009, reason: 'Message too large' });
      expect(record(harness.source.snapshot(), 'close')).toMatchObject({
        count: 4,
        succeeded: 2,
        failed: 2,
        backpressureCloses: null,
      });
    });

    it('a handshake that fails after the upgrade was accepted is a failed open', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      route(harness);
      const sink = await accept(harness);
      sink.onClose({ code: 1006, reason: '' });
      expect(record(harness.source.snapshot(), 'open')).toMatchObject({
        count: 1,
        succeeded: 0,
        failed: 1,
      });
      expect(record(harness.source.snapshot(), 'close')).toBeUndefined();
    });

    it('an idle connection outlives its records: gauges stay current and the source stays ready', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      route(harness);
      open(await accept(harness));
      harness.runtime.advance(60_001);
      const snapshot = harness.source.snapshot();
      expect(snapshot.records).toEqual([]);
      expect(snapshot.state).toBe('ready');
      expect(snapshot.gauges).toEqual({ state: 'available', openConnections: 1, groups: 0 });
    });

    it('sees a group-only change, and repeated reads create no group', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      harness.service.room('created-by-application');
      const before = harness.service.roomCount;
      for (let index = 0; index < 5; index++) {
        expect(harness.source.snapshot().gauges.groups).toBe(1);
      }
      expect(harness.service.roomCount).toBe(before);
    });

    it('reports openConnections 0 after the last connection closes', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      route(harness);
      const sink = await accept(harness);
      open(sink);
      expect(harness.source.snapshot().gauges.openConnections).toBe(1);
      sink.onClose({ code: 1000, reason: '' });
      expect(harness.source.snapshot().gauges.openConnections).toBe(0);
    });

    it('reads the ORIGINAL service after the capability is replaced', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      route(harness);
      open(await accept(harness));
      harness.replaceService({
        get connectionCount(): number {
          throw new Error('the replacement must never be read');
        },
      });
      expect(harness.source.snapshot().gauges).toEqual({
        state: 'available',
        openConnections: 1,
        groups: 0,
      });
    });

    it('carries no frame, reason, query, id or room name — with approved counts as the control', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const opened = route(harness);
      const sink = await accept(harness, 'http://localhost/ws?token=CANARY-query');
      open(sink);
      const conn = opened[0]!;
      harness.service.room('CANARY-room').add(conn);
      conn.send('CANARY-frame');
      sink.onMessage('CANARY-inbound');
      sink.onError(new Error('CANARY-error'));
      sink.onClose({ code: 4000, reason: 'CANARY-reason' });
      const serialized = JSON.stringify(harness.source.snapshot());
      expect(serialized).not.toContain('CANARY');
      expect(serialized).not.toContain(conn.id);
      // Positive control: the approved data is there, so dropping every record
      // could not pass this test.
      expect(serialized).toContain('chat-hub');
      expect(record(harness.source.snapshot(), 'send')?.count).toBe(1);
      expect(record(harness.source.snapshot(), 'close')?.failed).toBe(1);
    });

    it('does not change sends, closes or membership compared with an unobserved plugin', async () => {
      const run = async (options?: WebSocketPluginOptions) => {
        const harness = await setup(options);
        const opened = route(harness);
        const a = open(await accept(harness));
        const b = open(await accept(harness));
        harness.service.room('r').add(opened[0]!);
        harness.service.room('r').add(opened[1]!);
        harness.service.room('r').broadcast('hi', { except: opened[0]! });
        opened[0]!.sendJson({ n: 1 });
        opened[1]!.close(1001, 'bye');
        return {
          a: [...a.sent],
          b: [...b.sent],
          closes: [...b.closes],
          size: harness.service.room('r').size,
          connections: harness.service.connectionCount,
        };
      };
      expect(await run({ diagnostics: ENABLED })).toEqual(await run());
    });
  });

  describe('teardown', () => {
    it('detaches first, then closes: disabled gauges, no reader call, no late counts', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const opened = route(harness);
      const sink = await accept(harness);
      open(sink);
      let reads = 0;
      Object.defineProperty(harness.service, 'connectionCount', {
        get: () => {
          reads++;
          return 1;
        },
      });
      for (const hook of harness.closeHooks) {
        hook();
      }
      expect(realtimeObserverOf(harness.service)).toBeUndefined();
      sink.onClose({ code: 1001, reason: '' });
      expect(() => opened[0]!.send('late')).toThrow();
      const snapshot = harness.source.snapshot();
      expect(snapshot.state).toBe('disabled');
      expect(snapshot.sourceKind).toBe('websocket');
      expect(snapshot.gauges).toEqual({ state: 'disabled', openConnections: null, groups: null });
      expect(snapshot.records).toEqual([]);
      expect(reads).toBe(0);
    });
  });
});
