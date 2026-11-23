import { describe, expect, it, vi } from 'vitest';
import {
  adaptPubSubModule,
  GcpPubSubBroker,
  type PubSubSdkModule,
} from '../../src/brokers/pubsub-broker.ts';
import { PubSubOrdering } from '../../src/brokers/pubsub-ordering.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud } from '../fixtures/cloud-transports.ts';

function orderedBroker(enabled: boolean, handler: (n: number) => void | Promise<void>) {
  const clock = clockRuntime();
  let receive: (message: unknown) => void = () => {};
  let closed: () => void = () => {};
  const sdk: PubSubSdkModule = {
    PubSub: class {
      getTopics() {
        return Promise.resolve([]);
      }
      topic() {
        return {
          publishMessage: () => Promise.resolve('id'),
          createSubscription: () => Promise.resolve([]),
        };
      }
      subscription() {
        return {
          on(event: string, callback: (message: never) => void): void {
            if (event === 'message') receive = callback as (message: unknown) => void;
            if (event === 'close') closed = () => callback(undefined as never);
          },
          close: () => Promise.resolve(),
          delete: () => Promise.resolve(),
          getMetadata: () =>
            Promise.resolve<[{ topic: string }]>([{ topic: 'projects/p/topics/orders' }]),
        };
      }
      close() {
        return Promise.resolve();
      }
    },
  };
  const transport = adaptPubSubModule(sdk, { projectId: 'p', enableMessageOrdering: enabled });
  const warn = vi.fn();
  const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
    client: transport,
    deadLetterTopic: 'dead',
    logger: { error: vi.fn(), warn },
  });
  const acked: number[] = [];
  const nacked: number[] = [];
  return {
    broker,
    clock,
    warn,
    start: async () => {
      await broker.connect();
      await broker.subscribe<number>('orders', handler);
    },
    deliver: (n: number, orderingKey?: string): void =>
      receive({
        data: new TextEncoder().encode(String(n)),
        id: String(n),
        ack: () => {
          acked.push(n);
        },
        nack: () => {
          nacked.push(n);
        },
        ...(orderingKey === undefined ? {} : { orderingKey }),
      }),
    closed: () => closed(),
    acked,
    nacked,
  };
}

describe('Pub/Sub ordered async handler dispatch', () => {
  it('serializes a key while other keys and unkeyed deliveries remain concurrent', async () => {
    const pending = Promise.withResolvers<void>();
    const starts: number[] = [];
    const ends: number[] = [];
    const h = orderedBroker(true, async (n) => {
      starts.push(n);
      if (n === 0) await pending.promise;
      ends.push(n);
    });
    await h.start();
    h.deliver(0, 'a');
    h.deliver(1, 'a');
    h.deliver(2, 'b');
    h.deliver(3);
    await flushCloud();
    expect(starts).toHaveLength(3);
    expect(new Set(starts)).toEqual(new Set([0, 2, 3]));
    expect(new Set(ends)).toEqual(new Set([2, 3]));
    pending.resolve();
    await flushCloud();
    expect(starts.at(-1)).toBe(1);
    expect(new Set(h.acked)).toEqual(new Set([0, 1, 2, 3]));
    expect(h.acked.indexOf(0)).toBeLessThan(h.acked.indexOf(1));
    await h.broker.disconnect();
  });
  it('nacks buffered later messages after failure and resumes at head redelivery', async () => {
    const starts: number[] = [];
    let fail = true;
    const h = orderedBroker(true, (n) => {
      starts.push(n);
      if (n === 4 && fail) {
        fail = false;
        throw new Error('failed');
      }
    });
    await h.start();
    for (let n = 0; n < 7; n++) h.deliver(n, 'key');
    await flushCloud();
    expect(starts).toEqual([0, 1, 2, 3, 4]);
    expect(h.nacked).toEqual([4, 5, 6]);
    for (const n of [4, 5, 6]) h.deliver(n, 'key');
    await flushCloud();
    expect(starts).toEqual([0, 1, 2, 3, 4, 4, 5, 6]);
    expect(h.acked).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      h.warn.mock.calls.filter(([message]) =>
        String(message).includes('also spend delivery attempts'),
      ),
    ).toHaveLength(1);
    await h.broker.disconnect();
  });
  it('unblocks on any nacked redelivery when the failed head never returns', async () => {
    const starts: number[] = [];
    const h = orderedBroker(true, (n) => {
      starts.push(n);
      if (n === 0) throw new Error('exhausted head');
    });
    await h.start();
    h.deliver(0, 'key');
    h.deliver(1, 'key');
    h.deliver(2, 'key');
    await flushCloud();
    expect(h.nacked).toEqual([0, 1, 2]);
    h.deliver(2, 'key');
    await flushCloud();
    expect(starts).toEqual([0, 2]);
    await h.broker.disconnect();
  });
  it('drops buffered work without settling when a stream closes', async () => {
    const pending = Promise.withResolvers<void>();
    const starts: number[] = [];
    const h = orderedBroker(true, async (n) => {
      starts.push(n);
      await pending.promise;
    });
    await h.start();
    h.deliver(0, 'key');
    h.deliver(1, 'key');
    await flushCloud();
    h.closed();
    pending.resolve();
    await flushCloud();
    expect(starts).toEqual([0]);
    expect(h.acked).toEqual([]);
    expect(h.nacked).toEqual([]);
    await h.broker.disconnect();
    expect(h.clock.timerCount()).toBe(0);
  });
  it('retains concurrent dispatch when ordering is disabled', async () => {
    const pending = Promise.withResolvers<void>();
    const starts: number[] = [];
    const h = orderedBroker(false, async (n) => {
      starts.push(n);
      await pending.promise;
    });
    await h.start();
    h.deliver(0, 'key');
    h.deliver(1, 'key');
    await flushCloud();
    expect(starts).toEqual([0, 1]);
    pending.resolve();
    await flushCloud();
    await h.broker.disconnect();
  });
  it('supports empty keys, missing platform identity and dispatch rejection without retaining a broken tail', async () => {
    const gate = new PubSubOrdering();
    const nack = vi.fn();
    await gate.run({ orderingKey: '', nack }, () => Promise.resolve(true));
    await gate.run({ orderingKey: 'key', nack }, () => Promise.resolve(false));
    const cause = new Error('settle failed');
    await expect(
      gate.run({ orderingKey: 'key', messageId: '1', nack }, () => Promise.reject(cause)),
    ).rejects.toBe(cause);
    await gate.run({ orderingKey: 'key', messageId: '2', nack }, () => Promise.resolve(true));
    expect(nack).not.toHaveBeenCalled();
    gate.clear();
  });
});
