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
}

function makeAmqp(): FakeAmqp {
  let consumeCalls = 0;
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
  });

  const client = {
    createChannel: () => Promise.resolve(makeChannel()),
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
  };
}

describe('RabbitMqBroker health + drive-mode reconnect (M70c)', () => {
  it('reports down (not started) before connect', async () => {
    const { client } = makeAmqp();
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    expect(broker.isReady()).toBe(false);
    // No fault has occurred, so the probe is true; the indicator maps the
    // not-started lifecycle to down via isReady.
    expect(await broker.reachability()).toBe(true);
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
    expect(consumeCount()).toBeGreaterThan(before);
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
});
