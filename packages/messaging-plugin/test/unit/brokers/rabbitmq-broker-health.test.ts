import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import type { IAmqpConnection } from '../../../src/interfaces/index.ts';
import { RabbitMqBroker } from '../../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

/**
 * Drains the microtask queue: a real 0ms macrotask runs only after every
 * pending microtask (the drive-mode attempt chain) has settled. The fake
 * clock's timers are a separate mechanism and are unaffected.
 */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A controllable clock so the drive-mode backoff is deterministic and can be
 * flushed without real waiting (mirrors reconnect.test.ts).
 */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    setTimeout: (fn: () => void, ms: number): TimerHandle => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return { id } as TimerHandle;
    },
    clearTimeout: (handle: TimerHandle) => {
      timers.delete((handle as { id: number }).id);
    },
  };
}

function makeRuntime(clock: ReturnType<typeof makeClock>): IRuntimeServices {
  const base = createFakeRuntime();
  return {
    ...base,
    now: () => clock.now(),
    hrtime: () => clock.now(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
    clearInterval: (handle: TimerHandle) => clock.clearTimeout(handle),
  };
}

interface FakeAmqp {
  client: IAmqpConnection;
  fire: (event: string) => void;
  /** Number of consume() calls across all channels (replay re-subscribes). */
  consumeCount: () => number;
  /** Number of createChannel() calls on the CONNECTION (M95b §3.6 probe counting). */
  channelOpens: () => number;
  /** Number of channel close() calls (the probe must close every channel it opens). */
  channelCloses: () => number;
}

function makeAmqp(): FakeAmqp {
  let consumeCalls = 0;
  let openCalls = 0;
  let closeCalls = 0;
  const listeners = new Map<string, Array<(err?: unknown) => void>>();

  const makeChannel = () => ({
    assertExchange: () => Promise.resolve(),
    assertQueue: (queue: string) => Promise.resolve({ queue }),
    bindQueue: () => Promise.resolve(),
    consume: () => {
      consumeCalls++;
      return Promise.resolve({ consumerTag: `c-${consumeCalls}` });
    },
    ack: () => {},
    nack: () => {},
    cancel: () => Promise.resolve(),
    deleteQueue: () => Promise.resolve(),
    publish: () => true,
    close: () => {
      closeCalls++;
      return Promise.resolve();
    },
  });

  const client = {
    createChannel: () => {
      openCalls++;
      return Promise.resolve(makeChannel());
    },
    close: () => Promise.resolve(),
    on: (event: string, listener: (err?: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    },
    off: (event: string, listener: (err?: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(listener);
      if (idx !== -1) {
        arr.splice(idx, 1);
      }
    },
  } as unknown as IAmqpConnection;

  return {
    client,
    fire: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    consumeCount: () => consumeCalls,
    channelOpens: () => openCalls,
    channelCloses: () => closeCalls,
  };
}

describe('RabbitMqBroker health + drive-mode reconnect (M70c)', () => {
  it('reports down (not started) before connect', async () => {
    const { client } = makeAmqp();
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    expect(broker.isReady()).toBe(false);
    // M95b §3.6: with no open connection there is nothing to round-trip, so
    // the probe says false. The indicator still gates on isReady() first, so
    // the observable not-started report is unchanged: down either way.
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('reports up while connected with no fault', async () => {
    const { client } = makeAmqp();
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('a close event flips isHealthy to false while isReady stays true', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    const { client, fire } = makeAmqp();
    const broker = new RabbitMqBroker(runtime, new JsonSerializer(), { client });
    await broker.connect();
    expect(await broker.reachability()).toBe(true);
    // A 'close' event opens the fault window. The drive-mode attempt is
    // scheduled on the controllable clock and NOT advanced, so it never fires
    // during the assertion and leaves no dangling real timer.
    fire('close');
    expect(broker.isReady()).toBe(true); // lifecycle intact
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('a real error+close pair replays each subscription exactly once', async () => {
    // amqplib's `onSocketError` emits `'error'` and THEN `'close'` (verified
    // in amqplib 0.10.9: onSocketError emits 'error', then toClosed emits
    // 'close'), and both are wired to the same fault listener. Every other
    // test in this file fires only `'close'`, so the fake never reproduced the
    // real sequence and a duplicate reconnect could not be constructed. The
    // exact count is the assertion that matters: a `toBeGreaterThan` passes
    // just as happily with two replays as with one.
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    const { client, fire, consumeCount } = makeAmqp();
    const broker = new RabbitMqBroker(runtime, new JsonSerializer(), { client });
    await broker.connect();

    await broker.subscribe('orders.created', () => {});
    const before = consumeCount();
    expect(before).toBe(1);

    fire('error');
    fire('close');
    expect(await broker.reachability()).toBe(false);

    clock.advance(10_000);
    await flush();

    expect(await broker.reachability()).toBe(true);
    expect(consumeCount()).toBe(before + 1);
  });

  it('drive mode reconnects, re-asserts, and replays subscriptions (X2-1)', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    const { client, fire, consumeCount } = makeAmqp();
    const broker = new RabbitMqBroker(runtime, new JsonSerializer(), { client });
    await broker.connect();

    // Establish a subscription before the outage.
    await broker.subscribe('orders.created', () => {});
    const before = consumeCount();
    expect(before).toBe(1);

    // The broker goes away.
    fire('close');
    expect(await broker.reachability()).toBe(false);

    // Flush the (tiny) backoff so the drive-mode attempt runs, then drain the
    // async attempt chain.
    clock.advance(10_000);
    await flush();

    // The fault is cleared and the subscription was replayed on the fresh
    // channel — this is the X2-1 reproduction (queues showed no consumers
    // after a broker restart and never recovered, without replay).
    expect(await broker.reachability()).toBe(true);
    // Exact, not `toBeGreaterThan`: a loose bound passes just as happily with
    // a duplicated replay, which is precisely the defect the sibling
    // error+close test exists to catch.
    expect(consumeCount()).toBe(before + 1);
  });

  it('a failing reconnect retries rather than terminating', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    const { client, fire } = makeAmqp();
    const broker = new RabbitMqBroker(runtime, new JsonSerializer(), { client });
    await broker.connect();
    // Now make createChannel fail so every drive-mode reconnect attempt fails.
    (client as unknown as { createChannel: () => Promise<unknown> }).createChannel = () => {
      return Promise.reject(new Error('broker still down'));
    };
    fire('close');
    // Flush several backoff windows; each failed attempt reschedules.
    for (let i = 0; i < 4; i++) {
      clock.advance(10_000);
      await flush();
    }
    // Still faulted (never succeeded), not terminated.
    expect(await broker.reachability()).toBe(false);
  });

  it('a client without an event surface yields a no-op fault disposer', async () => {
    // Minimal injected client: createChannel only, no on/off. The fault window
    // is then only observable through the probe (no fault flag is ever set).
    const client = {
      createChannel: () => Promise.resolve({ assertExchange: () => Promise.resolve() }),
      close: () => Promise.resolve(),
    } as unknown as IAmqpConnection;
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
  });

  it('a client without off() detaches without throwing', async () => {
    const listeners = new Map<string, Array<() => void>>();
    const client = {
      createChannel: () => Promise.resolve({ assertExchange: () => Promise.resolve() }),
      close: () => Promise.resolve(),
      on: (event: string, listener: () => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(listener);
        listeners.set(event, arr);
      },
      // no off(): the disposer must skip removal rather than throw
    } as unknown as IAmqpConnection;
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    // disconnect() stops the supervisor, which runs the disposer; with no off
    // the disposer is a no-op and must not throw.
    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
  });

  it('rejects an injected client that is not an object', async () => {
    const broker = new RabbitMqBroker(
      createFakeRuntime(),
      new JsonSerializer(),
      { client: 'not-an-object' as unknown as IAmqpConnection },
    );
    await expect(broker.connect()).rejects.toThrow(
      'Injected AMQP client does not match the required structural shape',
    );
  });

  it('rejects an injected client missing createChannel', async () => {
    const broker = new RabbitMqBroker(
      createFakeRuntime(),
      new JsonSerializer(),
      { client: { close: () => Promise.resolve() } as unknown as IAmqpConnection },
    );
    await expect(broker.connect()).rejects.toThrow(
      'Injected AMQP client does not match the required structural shape',
    );
  });

  it('rejects an injected client missing close', async () => {
    const broker = new RabbitMqBroker(
      createFakeRuntime(),
      new JsonSerializer(),
      {
        client: {
          createChannel: () => Promise.resolve({ assertExchange: () => Promise.resolve() }),
        } as unknown as IAmqpConnection,
      },
    );
    await expect(broker.connect()).rejects.toThrow(
      'Injected AMQP client does not match the required structural shape',
    );
  });

  describe('the probe is a real round trip (M95b §3.6)', () => {
    it('opens a channel, answers true, and closes the throwaway channel', async () => {
      const { client, channelOpens, channelCloses } = makeAmqp();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();

      const opensBefore = channelOpens();
      expect(await broker.reachability()).toBe(true);
      // The probe is the round trip — one open per poll...
      expect(channelOpens()).toBe(opensBefore + 1);
      // ...and the finally closed the channel it opened. A leaked channel
      // per poll would be its own defect.
      expect(channelCloses()).toBe(1);
    });

    it('the faulted short-circuit answers false with NO round trip', async () => {
      const { client, fire, channelOpens } = makeAmqp();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      fire('close');
      const opensBefore = channelOpens();
      expect(await broker.reachability()).toBe(false);
      expect(await broker.isHealthy()).toBe(false);
      // The fault window is a positively known outage: probing through a
      // dying connection would only burn it.
      expect(channelOpens()).toBe(opensBefore);
    });

    it('answers false with no open connection and no round trip', async () => {
      const { client, channelOpens } = makeAmqp();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      expect(await broker.reachability()).toBe(false);
      expect(channelOpens()).toBe(0);
    });

    it('answers false when the broker refuses the channel', async () => {
      const { client } = makeAmqp();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      (client as unknown as { createChannel: () => Promise<unknown> }).createChannel = () =>
        Promise.reject(new Error('CHANNEL_ERROR - refused'));
      expect(await broker.reachability()).toBe(false);
      expect(await broker.isHealthy()).toBe(false);
    });

    it('answers false when the throwaway channel refuses to close', async () => {
      const { client } = makeAmqp();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      (client as unknown as { createChannel: () => Promise<unknown> }).createChannel = () =>
        Promise.resolve({
          assertExchange: () => Promise.resolve(),
          close: () => Promise.reject(new Error('close failed')),
        });
      // The finally close rejects, the rejection escapes the inner try, and
      // the outer catch answers false: a channel that cannot be released is
      // not a proven-healthy broker.
      expect(await broker.reachability()).toBe(false);
    });

    it('health polls never touch the shared channel: publish still works after N polls', async () => {
      const clock = makeClock();
      const { client, channelOpens } = makeAmqp();
      const broker = new RabbitMqBroker(makeRuntime(clock), new JsonSerializer(), { client });
      await broker.connect();

      const opensBefore = channelOpens();
      for (let i = 0; i < 5; i++) {
        // Past the TTL each time, so all five are REAL round trips rather
        // than four cache hits — otherwise this guard would only ever
        // exercise one poll and could not see a probe that corrupts the
        // shared channel on its second use.
        clock.advance(6000);
        expect(await broker.reachability()).toBe(true);
      }
      expect(channelOpens()).toBe(opensBefore + 5);
      // The probe's channel is its own; if any poll had touched (or leaked a
      // fault into) #channel, the publish below would fail.
      await broker.publish('orders.created', { id: 1 });
    });
  });

  describe('the probe is cached and bounded IN THE BROKER (M95b review)', () => {
    it('two polls inside the TTL issue ONE round trip', async () => {
      const clock = makeClock();
      const { client, channelOpens } = makeAmqp();
      const broker = new RabbitMqBroker(makeRuntime(clock), new JsonSerializer(), { client });
      await broker.connect();

      const opensBefore = channelOpens();
      expect(await broker.reachability()).toBe(true);
      clock.advance(4999);
      expect(await broker.reachability()).toBe(true);
      // The bound and the cache live in the broker, not only at the health
      // indicator, because the indicator is not the only caller: the
      // realtime backplane delegates to `isHealthy()` directly and keeps no
      // cache of its own. Uncached, this is one AMQP channel open per health
      // poll per replica, forever.
      expect(channelOpens()).toBe(opensBefore + 1);

      clock.advance(1);
      expect(await broker.reachability()).toBe(true);
      expect(channelOpens()).toBe(opensBefore + 2);
    });

    it('a HUNG broker resolves undefined inside the bound instead of never settling', async () => {
      const clock = makeClock();
      const { client } = makeAmqp();
      const broker = new RabbitMqBroker(makeRuntime(clock), new JsonSerializer(), { client });
      await broker.connect();

      // The `docker pause` shape: the socket stays open and the channel open
      // never settles. Before the broker-level bound this promise never
      // resolved, so `realtime-backplane-plugin` — which awaits
      // `isHealthy()` with no bound of its own — hit HealthPlugin's
      // indicator deadline and reported `down`, taking /ready to 503 for a
      // fan-out failure its own contract says is `degraded` at worst.
      (client as unknown as { createChannel: () => Promise<unknown> }).createChannel = () =>
        new Promise<unknown>(() => {});

      clock.advance(6000);
      const pending = broker.reachability();
      clock.advance(2000);
      expect(await pending).toBeUndefined();

      // The boolean port member reports "not known down" for an
      // unanswerable probe (the committed M70c rule), so a hung broker no
      // longer drains a replica through the backplane indicator.
      clock.advance(6000);
      const health = broker.isHealthy();
      clock.advance(2000);
      expect(await health).toBe(true);
    });

    it('disconnect drops the cache, so a stale true cannot outlive the connection', async () => {
      const clock = makeClock();
      const { client, channelOpens } = makeAmqp();
      const broker = new RabbitMqBroker(makeRuntime(clock), new JsonSerializer(), { client });
      await broker.connect();
      expect(await broker.reachability()).toBe(true);

      await broker.disconnect();
      const opensAfterDisconnect = channelOpens();
      // Inside what WOULD still be the TTL: the answer must be `false`
      // (no connection), never the cached `true`, and it must fire no I/O.
      expect(await broker.reachability()).toBe(false);
      expect(channelOpens()).toBe(opensAfterDisconnect);
    });
  });
});
