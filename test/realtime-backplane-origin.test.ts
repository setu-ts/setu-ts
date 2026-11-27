/**
 * The self-echo rule, the same on every backplane transport.
 *
 * `RealtimeFrame.origin` names the publishing instance, and a subscriber drops a
 * frame carrying its own. On the Durable Object transport that rule is now the
 * only thing that keeps a replica from hearing itself: `publish` goes through the
 * hub's HTTP publish, which fans out to every socket, the publisher's own
 * included. The table drives each transport over one shared fake medium and
 * checks the same four cases, so a transport whose rule drifts fails here.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';

import type {
  IMessageBroker,
  IRealtimeBackplane,
  ISubscription,
  MessageHandler,
  RealtimeFrame,
} from '@setu-ts/common';
import { MemoryBackplane } from '../packages/realtime-backplane-plugin/src/transports/memory-backplane.ts';
import { MessagingBackplane } from '../packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts';
import { RedisBackplane } from '../packages/realtime-backplane-plugin/src/transports/redis-backplane.ts';
import type { IRedisBackplaneClient } from '../packages/realtime-backplane-plugin/src/interfaces/index.ts';
import { DurableObjectBackplane } from '../packages/cloudflare-plugin/src/realtime/durable-object-backplane.ts';
import { FakeDurableObjectNamespace } from '../packages/cloudflare-plugin/test/do-fakes.ts';
import { WorkersResponse } from './node-helpers.ts';

/** Two replicas on one medium, plus a way to put raw traffic on it. */
interface Pair {
  readonly a: IRealtimeBackplane;
  readonly b: IRealtimeBackplane;
  /** Puts a value on the medium as a third party would, reaching both replicas. */
  readonly inject: (value: unknown) => Promise<void>;
}

/** A broker that fans every publish out to every subscriber, the publisher's own included. */
class FanOutBroker implements IMessageBroker {
  readonly #handlers = new Set<MessageHandler<unknown>>();
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  async publish<T>(topic: string, message: T): Promise<void> {
    for (const handler of this.#handlers) await handler(message, { topic });
  }
  subscribe<T>(_topic: string, handler: MessageHandler<T>): Promise<ISubscription> {
    const h = handler as MessageHandler<unknown>;
    this.#handlers.add(h);
    return Promise.resolve({
      fanOut: true,
      unsubscribe: (): Promise<void> => {
        this.#handlers.delete(h);
        return Promise.resolve();
      },
    });
  }
  request<TRes>(): Promise<TRes> {
    return Promise.reject(new Error('not used'));
  }
  respond(): Promise<ISubscription> {
    return Promise.reject(new Error('not used'));
  }
}

/** One Redis server: a PUBLISH reaches every subscribed connection, the publisher's own included. */
class FakeRedisServer {
  readonly #subscribers = new Set<FakeRedisConnection>();
  publish(channel: string, message: string): number {
    for (const connection of this.#subscribers) connection.receive(channel, message);
    return this.#subscribers.size;
  }
  join(connection: FakeRedisConnection): void {
    this.#subscribers.add(connection);
  }
  leave(connection: FakeRedisConnection): void {
    this.#subscribers.delete(connection);
  }
}

class FakeRedisConnection implements IRedisBackplaneClient {
  readonly #server: FakeRedisServer;
  readonly #listeners = new Set<(channel: string, message: string) => void>();
  constructor(server: FakeRedisServer) {
    this.#server = server;
  }
  publish(channel: string, message: string): Promise<number> {
    return Promise.resolve(this.#server.publish(channel, message));
  }
  subscribe(): Promise<unknown> {
    this.#server.join(this);
    return Promise.resolve(1);
  }
  unsubscribe(): Promise<unknown> {
    this.#server.leave(this);
    return Promise.resolve(0);
  }
  on(event: string, listener: (channel: string, message: string) => void): void {
    if (event === 'message') this.#listeners.add(listener);
  }
  off(event: string, listener: (channel: string, message: string) => void): void {
    if (event === 'message') this.#listeners.delete(listener);
  }
  quit(): Promise<unknown> {
    this.#server.leave(this);
    return Promise.resolve('OK');
  }
  receive(channel: string, message: string): void {
    for (const listener of this.#listeners) listener(channel, message);
  }
}

let busCount = 0;

const TRANSPORTS: ReadonlyArray<{ readonly name: string; readonly build: () => Pair }> = [
  {
    name: 'memory',
    build: (): Pair => {
      const bus = `origin-table-${++busCount}`;
      const a = new MemoryBackplane('a', bus);
      const b = new MemoryBackplane('b', bus);
      const third = new MemoryBackplane('third', bus);
      return {
        a,
        b,
        inject: async (value): Promise<void> => {
          await third.connect();
          await third.publish(value as RealtimeFrame);
        },
      };
    },
  },
  {
    name: 'messaging',
    build: (): Pair => {
      const broker = new FanOutBroker();
      return {
        a: new MessagingBackplane(broker, 'a', 'realtime'),
        b: new MessagingBackplane(broker, 'b', 'realtime'),
        inject: (value): Promise<void> => broker.publish('realtime', value),
      };
    },
  },
  {
    name: 'redis',
    build: (): Pair => {
      const server = new FakeRedisServer();
      const replica = (origin: string): RedisBackplane =>
        new RedisBackplane(
          {
            transport: 'redis',
            client: new FakeRedisConnection(server),
            subscriber: new FakeRedisConnection(server),
          },
          origin,
          'realtime',
        );
      return {
        a: replica('a'),
        b: replica('b'),
        inject: (value): Promise<void> => {
          server.publish('realtime', JSON.stringify(value));
          return Promise.resolve();
        },
      };
    },
  },
  {
    name: 'durable-object',
    build: (): Pair => {
      const namespace = new FakeDurableObjectNamespace();
      const replica = (origin: string): DurableObjectBackplane =>
        new DurableObjectBackplane(namespace, { origin, binding: 'REALTIME', topic: 'realtime' });
      return {
        a: replica('a'),
        b: replica('b'),
        // A third party's POST to the hub, which fans out to every socket.
        inject: async (value): Promise<void> => {
          await namespace
            .get(namespace.idFromName('realtime'))
            .fetch('https://realtime-backplane.internal/publish', {
              method: 'POST',
              body: JSON.stringify(value),
            });
        },
      };
    },
  },
];

const FRAME = (origin: string): RealtimeFrame => ({
  kind: 'sse-channel',
  origin,
  name: 'news',
  data: '"hello"',
});

describe.each(TRANSPORTS)('the $name backplane and the frame origin', ({ build }) => {
  const nativeResponse = globalThis.Response;

  async function open(): Promise<{
    pair: Pair;
    seenA: RealtimeFrame[];
    seenB: RealtimeFrame[];
    done: () => Promise<void>;
  }> {
    // The Workers fakes answer a 101 that Node's own Response refuses to build.
    globalThis.Response = WorkersResponse;
    const pair = build();
    const seenA: RealtimeFrame[] = [];
    const seenB: RealtimeFrame[] = [];
    await pair.a.connect();
    await pair.b.connect();
    await pair.a.subscribe((frame) => seenA.push(frame));
    await pair.b.subscribe((frame) => seenB.push(frame));
    return {
      pair,
      seenA,
      seenB,
      done: async (): Promise<void> => {
        await pair.a.close();
        await pair.b.close();
        globalThis.Response = nativeResponse;
      },
    };
  }

  it("delivers a publish to the other replica and never back to the publisher's own handlers", async () => {
    const { pair, seenA, seenB, done } = await open();
    try {
      await pair.a.publish(FRAME('a'));
      await setImmediate();

      expect(seenB).toEqual([FRAME('a')]);
      expect(seenA).toEqual([]);
    } finally {
      await done();
    }
  });

  it("drops a frame stamped with the receiver's own origin, whoever sent it", async () => {
    // A forged origin can only silence delivery to the replica it names.
    const { pair, seenA, seenB, done } = await open();
    try {
      await pair.inject(FRAME('b'));
      await setImmediate();

      expect(seenB).toEqual([]);
      expect(seenA).toEqual([FRAME('b')]);
    } finally {
      await done();
    }
  });

  it('drops a frame with no origin, or a non-string one, on every replica', async () => {
    const { pair, seenA, seenB, done } = await open();
    try {
      await pair.inject({ kind: 'sse-channel', name: 'news', data: '"hello"' });
      await pair.inject({ ...FRAME('x'), origin: 7 });
      await setImmediate();

      expect(seenA).toEqual([]);
      expect(seenB).toEqual([]);
    } finally {
      await done();
    }
  });

  it('carries both exclusion fields across, unchanged', async () => {
    // A transport that rebuilt the frame from known fields would drop one.
    const { pair, seenA, seenB, done } = await open();
    try {
      const excluding: RealtimeFrame = {
        ...FRAME('a'),
        kind: 'ws-room',
        exceptId: 'conn-1',
        exceptIds: ['conn-2'],
      };
      await pair.a.publish(excluding);
      await pair.inject({ ...FRAME('x'), exceptIds: ['conn-2', 3] });
      await setImmediate();

      expect(seenB).toEqual([excluding]);
      expect(seenA).toEqual([]);
    } finally {
      await done();
    }
  });

  it('delivers a third party frame to both replicas', async () => {
    const { pair, seenA, seenB, done } = await open();
    try {
      await pair.inject(FRAME('third'));
      await setImmediate();

      expect(seenA).toEqual([FRAME('third')]);
      expect(seenB).toEqual([FRAME('third')]);
    } finally {
      await done();
    }
  });
});
