/**
 * M98l realtime observations for the realtime-backplane plugin: publish and
 * receive counts across the memory, messaging and redis transports (plan
 * §3.6), unsupported gauges and the age-based state, the disabled and
 * `'custom'` paths, canaries, observed-versus-unobserved parity, and
 * teardown.
 *
 * Driven through `RealtimeBackplanePlugin(...).register(...)` over a fake
 * context with a hand-advanced monotonic clock.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IMessageBroker,
  IPluginContext,
  IRealtimeBackplane,
  IRealtimeDiagnosticsSource,
  ISubscription,
  MessageHandler,
  RealtimeDiagnosticsSnapshot,
  RealtimeFrame,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { RealtimeBackplanePlugin } from '../../src/plugin/realtime-backplane-plugin.ts';
import type {
  IRedisBackplaneClient,
  RealtimeBackplanePluginOptions,
} from '../../src/interfaces/index.ts';
import { MemoryBackplane } from '../../src/transports/memory-backplane.ts';
import { realtimeObserverOf } from '../../src/diagnostics/realtime-observations.ts';

const ENABLED = { enabled: true, alias: 'fanout' } as const;
const ORIGIN = 'self-origin';

/** A broker fake honoring the async `IMessageBroker` contract. */
class FakeBroker implements IMessageBroker {
  readonly published: unknown[] = [];
  /** When set, the next `publish` waits for this before resolving. */
  hold: Promise<void> | undefined;
  /** When set, `publish` rejects with it. */
  fail: Error | undefined;
  #handler: MessageHandler<unknown> | undefined;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  async publish<T>(_topic: string, message: T): Promise<void> {
    this.published.push(message);
    if (this.hold !== undefined) {
      await this.hold;
    }
    if (this.fail !== undefined) {
      throw this.fail;
    }
  }
  subscribe<T>(_topic: string, handler: MessageHandler<T>): Promise<ISubscription> {
    this.#handler = handler as MessageHandler<unknown>;
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  }
  request<TRes>(): Promise<TRes> {
    return Promise.reject(new Error('not used'));
  }
  respond(): Promise<ISubscription> {
    return Promise.reject(new Error('not used'));
  }
  deliver(message: unknown): void {
    void this.#handler?.(message, { topic: 'setu-ts.realtime' });
  }
}

/** A redis client fake: a publisher that records, a subscriber that emits. */
class FakeRedis implements IRedisBackplaneClient {
  readonly published: string[] = [];
  /** When set, `publish` rejects with it — as ioredis does on a command timeout. */
  fail: Error | undefined;
  #listener: ((channel: string, message: string) => void) | undefined;
  publish(_channel: string, message: string): Promise<number> {
    if (this.fail !== undefined) {
      return Promise.reject(this.fail);
    }
    this.published.push(message);
    return Promise.resolve(1);
  }
  subscribe(): Promise<unknown> {
    return Promise.resolve(1);
  }
  unsubscribe(): Promise<unknown> {
    return Promise.resolve(0);
  }
  on(_event: string, listener: (channel: string, message: string) => void): void {
    this.#listener = listener;
  }
  off(): void {
    this.#listener = undefined;
  }
  quit(): Promise<unknown> {
    return Promise.resolve('OK');
  }
  emit(channel: string, message: string): void {
    this.#listener?.(channel, message);
  }
}

interface Harness {
  readonly backplane: IRealtimeBackplane;
  readonly source: IRealtimeDiagnosticsSource;
  readonly sources: unknown[];
  readonly closeHooks: (() => void | Promise<void>)[];
  advance(ms: number): void;
}

async function setup(
  options: RealtimeBackplanePluginOptions,
  broker?: FakeBroker,
): Promise<Harness> {
  let now = 1_000;
  const single = new Map<string, unknown>();
  if (broker !== undefined) {
    single.set(CAPABILITIES.MESSAGING, broker);
  }
  const multi = new Map<string, unknown[]>();
  const closeHooks: (() => void | Promise<void>)[] = [];
  const ctx = {
    runtime: { uuid: (): string => 'uuid-1', hrtime: (): number => now },
    services: {
      has: (token: string): boolean => single.has(token),
      get: <T>(token: string): T => single.get(token) as T,
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
      onClose: (hook: () => void | Promise<void>): void => {
        closeHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;
  await RealtimeBackplanePlugin(options).register(ctx);
  const sources = multi.get(CAPABILITIES.REALTIME_DIAGNOSTICS) ?? [];
  return {
    backplane: single.get(CAPABILITIES.REALTIME_BACKPLANE) as IRealtimeBackplane,
    source: sources[0] as IRealtimeDiagnosticsSource,
    sources,
    closeHooks,
    advance(ms: number): void {
      now += ms;
    },
  };
}

function frame(overrides: Partial<RealtimeFrame> = {}): RealtimeFrame {
  return { kind: 'ws-room', origin: 'peer-origin', name: 'lobby', data: 'hi', ...overrides };
}

function record(snapshot: RealtimeDiagnosticsSnapshot, operation: string) {
  return snapshot.records.find((entry) => entry.operation === operation);
}

let busCounter = 0;
/** A fresh memory bus name, so concurrent tests never share one. */
function bus(): string {
  return `m98l-bus-${++busCounter}`;
}

describe('RealtimeBackplanePlugin realtime observations (M98l)', () => {
  it('refuses an invalid diagnostics option when the plugin is constructed', () => {
    expect(() =>
      RealtimeBackplanePlugin({
        transport: 'memory',
        localNotice: false,
        diagnostics: { enabled: true, alias: 'x'.repeat(65) },
      })
    ).toThrow('1 to 64 UTF-8 bytes');
  });

  it('disabled by default: one inert backplane source, nothing attached, publish unchanged', async () => {
    const harness = await setup({ transport: 'memory', localNotice: false, bus: bus() });
    expect(harness.sources).toHaveLength(1);
    expect(Object.keys(harness.source)).toEqual(['snapshot']);
    expect(realtimeObserverOf(harness.backplane)).toBeUndefined();
    await harness.backplane.publish(frame());
    expect(harness.source.snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      sourceKind: 'backplane',
      coverage: 'owned-instance',
      gauges: { state: 'disabled', openConnections: null, groups: null },
      records: [],
      dropped: 0,
    });
  });

  it("never observes a 'custom' transport", async () => {
    const custom = new MemoryBackplane('custom-origin', bus());
    const harness = await setup({ transport: 'custom', instance: custom });
    expect(harness.backplane).toBe(custom);
    expect(realtimeObserverOf(custom)).toBeUndefined();
    await custom.publish(frame());
    expect(harness.source.snapshot().state).toBe('disabled');
  });

  describe('memory transport', () => {
    it('answers no-data with unsupported gauges, then counts publish and receive', async () => {
      const name = bus();
      const harness = await setup({
        transport: 'memory',
        localNotice: false,
        bus: name,
        origin: ORIGIN,
        diagnostics: ENABLED,
      });
      expect(harness.source.snapshot()).toMatchObject({
        state: 'no-data',
        alias: 'fanout',
        sourceKind: 'backplane',
        gauges: { state: 'unsupported', openConnections: null, groups: null },
        records: [],
      });
      const peer = new MemoryBackplane('peer-origin', name);
      await peer.connect();
      const received: string[] = [];
      await harness.backplane.subscribe((arrived) => received.push(arrived.name));
      await harness.backplane.publish(frame({ origin: ORIGIN }));
      await peer.publish(frame());
      const snapshot = harness.source.snapshot();
      expect(snapshot.state).toBe('ready');
      expect(record(snapshot, 'backplane-publish')).toMatchObject({
        count: 1,
        succeeded: 1,
        failed: 0,
        lastDurationMs: 0,
        backpressureCloses: null,
      });
      expect(record(snapshot, 'backplane-receive')).toMatchObject({
        count: 1,
        succeeded: 1,
        lastDurationMs: null,
      });
      expect(received).toEqual(['lobby']);
      await peer.close();
    });

    it('does not count a frame the own-origin filter drops', async () => {
      const name = bus();
      const harness = await setup({
        transport: 'memory',
        localNotice: false,
        bus: name,
        origin: ORIGIN,
        diagnostics: ENABLED,
      });
      const echo = new MemoryBackplane('another-instance', name);
      await echo.connect();
      await echo.publish(frame({ origin: ORIGIN }));
      expect(record(harness.source.snapshot(), 'backplane-receive')).toBeUndefined();
      await echo.close();
    });

    it('a throwing local handler fails the receive and the fan-out still continues', async () => {
      const name = bus();
      const harness = await setup({
        transport: 'memory',
        localNotice: false,
        bus: name,
        diagnostics: ENABLED,
      });
      const peer = new MemoryBackplane('peer-origin', name);
      await peer.connect();
      const after: string[] = [];
      await harness.backplane.subscribe(() => {
        throw new Error('CANARY-handler');
      });
      await harness.backplane.subscribe((arrived) => after.push(arrived.name));
      await peer.publish(frame());
      expect(after).toEqual(['lobby']);
      expect(record(harness.source.snapshot(), 'backplane-receive')).toMatchObject({
        succeeded: 0,
        failed: 1,
      });
      expect(JSON.stringify(harness.source.snapshot())).not.toContain('CANARY');
      await peer.close();
    });

    it('goes stale after 30 seconds and empties at the 60-second retention window', async () => {
      const harness = await setup({
        transport: 'memory',
        localNotice: false,
        bus: bus(),
        diagnostics: ENABLED,
      });
      await harness.backplane.publish(frame());
      harness.advance(30_001);
      expect(harness.source.snapshot().state).toBe('stale');
      harness.advance(30_000);
      expect(harness.source.snapshot()).toMatchObject({ state: 'no-data', records: [] });
    });
  });

  describe('messaging transport', () => {
    it('times a publish and passes the value through', async () => {
      const broker = new FakeBroker();
      const harness = await setup({ transport: 'messaging', diagnostics: ENABLED }, broker);
      let release: () => void = () => {};
      broker.hold = new Promise((resolve) => {
        release = resolve;
      });
      const pending = harness.backplane.publish(frame());
      harness.advance(42);
      release();
      await pending;
      expect(record(harness.source.snapshot(), 'backplane-publish')).toMatchObject({
        count: 1,
        succeeded: 1,
        lastDurationMs: 42,
      });
    });

    it('a rejected publish is failed and rejects with the ORIGINAL reason', async () => {
      const broker = new FakeBroker();
      const harness = await setup({ transport: 'messaging', diagnostics: ENABLED }, broker);
      const reason = new Error('CANARY-broker-down');
      broker.fail = reason;
      await expect(harness.backplane.publish(frame())).rejects.toBe(reason);
      expect(record(harness.source.snapshot(), 'backplane-publish')).toMatchObject({
        succeeded: 0,
        failed: 1,
      });
      expect(JSON.stringify(harness.source.snapshot())).not.toContain('CANARY');
    });

    it('counts a receive only after the shape and own-origin filters', async () => {
      const broker = new FakeBroker();
      const harness = await setup(
        { transport: 'messaging', origin: ORIGIN, diagnostics: ENABLED },
        broker,
      );
      await harness.backplane.subscribe(() => {});
      broker.deliver({ not: 'a frame' });
      broker.deliver(frame({ origin: ORIGIN }));
      broker.deliver(frame());
      expect(record(harness.source.snapshot(), 'backplane-receive')).toMatchObject({
        count: 1,
        succeeded: 1,
      });
    });
  });

  describe('redis transport', () => {
    it('counts a publish and a receive, ignoring unparseable and foreign messages', async () => {
      const client = new FakeRedis();
      const subscriber = new FakeRedis();
      const harness = await setup({
        transport: 'redis',
        client,
        subscriber,
        origin: ORIGIN,
        diagnostics: ENABLED,
      });
      await harness.backplane.subscribe(() => {});
      await harness.backplane.publish(frame());
      subscriber.emit('setu-ts.realtime', '{not json');
      subscriber.emit('other-channel', JSON.stringify(frame()));
      subscriber.emit('setu-ts.realtime', JSON.stringify(frame({ origin: ORIGIN })));
      subscriber.emit('setu-ts.realtime', JSON.stringify(frame()));
      const snapshot = harness.source.snapshot();
      expect(record(snapshot, 'backplane-publish')?.succeeded).toBe(1);
      expect(record(snapshot, 'backplane-receive')?.count).toBe(1);
      expect(client.published).toHaveLength(1);
    });

    it('a publish the connection rejects is failed and rejects with the ORIGINAL reason', async () => {
      const client = new FakeRedis();
      const harness = await setup({
        transport: 'redis',
        client,
        subscriber: new FakeRedis(),
        diagnostics: ENABLED,
      });
      // The shape ioredis produces when `commandTimeout` bounds a silent
      // connection, or when `maxRetriesPerRequest` exhausts on a dropped one.
      const timedOut = new Error('Command timed out');
      client.fail = timedOut;
      const outcome = harness.backplane.publish(frame());
      await expect(outcome).rejects.toBe(timedOut);
      const publish = record(harness.source.snapshot(), 'backplane-publish');
      expect(publish?.failed).toBe(1);
      expect(publish?.succeeded).toBe(0);
    });

    it('a publish after the plugin closes rejects rather than resolving', async () => {
      // A consumer still holding the transport after shutdown must learn the
      // frame went nowhere; it used to resolve as if it had been sent.
      const harness = await setup({
        transport: 'redis',
        client: new FakeRedis(),
        subscriber: new FakeRedis(),
        diagnostics: ENABLED,
      });
      await harness.closeHooks[0]?.();
      await expect(harness.backplane.publish(frame())).rejects.toThrow('not connected');
    });
  });

  it('carries no frame name, payload, origin or except id — with counts as the control', async () => {
    const broker = new FakeBroker();
    const harness = await setup(
      { transport: 'messaging', origin: 'CANARY-self', diagnostics: ENABLED },
      broker,
    );
    await harness.backplane.subscribe(() => {});
    const canary = frame({
      origin: 'CANARY-origin',
      name: 'CANARY-room',
      data: 'CANARY-data',
      exceptId: 'CANARY-except',
    });
    await harness.backplane.publish(canary);
    broker.deliver(canary);
    const serialized = JSON.stringify(harness.source.snapshot());
    expect(serialized).not.toContain('CANARY');
    expect(serialized).toContain('fanout');
    expect(record(harness.source.snapshot(), 'backplane-receive')?.count).toBe(1);
  });

  it('does not change transport calls or delivery compared with an unobserved plugin', async () => {
    const run = async (observed: boolean) => {
      const broker = new FakeBroker();
      const harness = await setup(
        {
          transport: 'messaging',
          origin: ORIGIN,
          ...(observed ? { diagnostics: ENABLED } : {}),
        },
        broker,
      );
      const delivered: string[] = [];
      await harness.backplane.subscribe((arrived) => delivered.push(arrived.name));
      await harness.backplane.publish(frame({ name: 'one' }));
      broker.deliver(frame({ name: 'two' }));
      broker.deliver(frame({ name: 'mine', origin: ORIGIN }));
      broker.fail = new Error('down');
      const outcome = await harness.backplane.publish(frame({ name: 'three' })).then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      return { published: broker.published, delivered, outcome };
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('teardown detaches and closes the collector before the transport closes', async () => {
    const name = bus();
    const harness = await setup({
      transport: 'memory',
      localNotice: false,
      bus: name,
      diagnostics: ENABLED,
    });
    await harness.backplane.publish(frame());
    for (const hook of harness.closeHooks) {
      await hook();
    }
    expect(realtimeObserverOf(harness.backplane)).toBeUndefined();
    await harness.backplane.publish(frame());
    expect(harness.source.snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      sourceKind: 'backplane',
      coverage: 'owned-instance',
      gauges: { state: 'disabled', openConnections: null, groups: null },
      records: [],
      dropped: 0,
    });
  });
});
