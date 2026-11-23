/**
 * Tests for the broker-backed backplane transport and its frame guard.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import type { IMessageBroker, ISubscription, MessageHandler, RealtimeFrame } from '@setu-ts/common';
import { isRealtimeFrame, MessagingBackplane } from '../../src/transports/messaging-backplane.ts';

/**
 * A broker fake honoring the committed `IMessageBroker` contract: `publish` and
 * `subscribe` are async, and `subscribe` resolves to an `ISubscription` whose
 * `unsubscribe` is also async.
 */
class FakeBroker implements IMessageBroker {
  readonly published: Array<{ topic: string; message: unknown }> = [];
  readonly subscribedTopics: string[] = [];
  unsubscribeCount = 0;
  #handler: MessageHandler<unknown> | undefined;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  publish<T>(topic: string, message: T): Promise<void> {
    this.published.push({ topic, message });
    return Promise.resolve();
  }
  subscribe<T>(topic: string, handler: MessageHandler<T>): Promise<ISubscription> {
    this.subscribedTopics.push(topic);
    this.#handler = handler as MessageHandler<unknown>;
    const subscription: ISubscription = {
      fanOut: true,
      unsubscribe: (): Promise<void> => {
        this.unsubscribeCount++;
        this.#handler = undefined;
        return Promise.resolve();
      },
    };
    return Promise.resolve(subscription);
  }
  request<TRes>(): Promise<TRes> {
    return Promise.reject(new Error('not used'));
  }
  respond(): Promise<ISubscription> {
    return Promise.reject(new Error('not used'));
  }

  /** Simulates a message arriving from the broker. */
  deliver(message: unknown): void {
    void this.#handler?.(message, { topic: 'topic' });
  }
}

const FRAME: RealtimeFrame = { kind: 'ws-room', origin: 'node-b', name: 'lobby', data: 'hi' };

it('captures asynchronous messaging subscriber errors in history and reporter', async () => {
  const broker = new FakeBroker();
  const failed = vi.fn();
  const succeeded = vi.fn();
  const backplane = new MessagingBackplane(broker, 'node-a', 'realtime', { failed, succeeded });
  const error = new Error('async messaging');
  const bad = async (): Promise<void> => {
    await Promise.resolve();
    throw error;
  };
  await backplane.connect();
  try {
    await backplane.subscribe(bad);
    broker.deliver(FRAME);
    await setImmediate();
    expect(backplane.handlerErrors).toEqual([error]);
    expect(failed).toHaveBeenCalledExactlyOnceWith(bad, error, FRAME);
  } finally {
    await backplane.close();
  }
});

describe('isRealtimeFrame', () => {
  it('accepts a well-formed frame of each kind', () => {
    expect(isRealtimeFrame(FRAME)).toBe(true);
    expect(isRealtimeFrame({ ...FRAME, kind: 'sse-channel' })).toBe(true);
    expect(isRealtimeFrame({ ...FRAME, binary: true })).toBe(true);
    expect(isRealtimeFrame({ ...FRAME, exceptId: 'conn-1' })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isRealtimeFrame(null)).toBe(false);
    expect(isRealtimeFrame('frame')).toBe(false);
    expect(isRealtimeFrame(undefined)).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isRealtimeFrame({ ...FRAME, kind: 'other' })).toBe(false);
  });

  it('rejects a frame with a missing or mistyped field', () => {
    expect(isRealtimeFrame({ ...FRAME, origin: 1 })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, name: undefined })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, data: 42 })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, binary: 'yes' })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, exceptId: 42 })).toBe(false);
  });
});

describe('MessagingBackplane', () => {
  it('subscribes to the configured topic on connect', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();
    expect(broker.subscribedTopics).toEqual(['realtime']);
    await backplane.close();
  });

  it('opens only one broker subscription however many handlers register', async () => {
    // A per-handler subscription would make each consumer a competing consumer
    // on a load-balancing broker, so only one would see any given frame.
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();
    await backplane.subscribe(() => {});
    await backplane.subscribe(() => {});
    await backplane.connect();
    expect(broker.subscribedTopics).toEqual(['realtime']);
    await backplane.close();
  });

  it('publishes the frame on the configured topic', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();
    await backplane.publish(FRAME);
    expect(broker.published).toEqual([{ topic: 'realtime', message: FRAME }]);
    await backplane.close();
  });

  it('delivers an arriving frame to every handler', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));
    broker.deliver(FRAME);

    expect(received).toEqual([FRAME]);
    await backplane.close();
  });

  it('drops an own-origin frame', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));
    broker.deliver({ ...FRAME, origin: 'node-a' });

    expect(received).toEqual([]);
    await backplane.close();
  });

  it('drops malformed traffic rather than crashing the delivery loop', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));

    // A broker topic is shared infrastructure; foreign messages are expected.
    broker.deliver('not a frame');
    broker.deliver({ kind: 'other' });
    broker.deliver(null);
    broker.deliver(FRAME);

    expect(received).toEqual([FRAME]);
    await backplane.close();
  });

  it('removes only the unsubscribed handler', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();

    const first: RealtimeFrame[] = [];
    const second: RealtimeFrame[] = [];
    const unsubscribe = await backplane.subscribe((f) => first.push(f));
    await backplane.subscribe((f) => second.push(f));

    broker.deliver(FRAME);
    unsubscribe();
    broker.deliver(FRAME);

    expect(first.length).toBe(1);
    expect(second.length).toBe(2);
    await backplane.close();
  });

  it('unsubscribes from the broker on close and tolerates a second close', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();
    await backplane.close();
    await backplane.close();
    expect(broker.unsubscribeCount).toBe(1);
  });
});

describe('MessagingBackplane handler isolation', () => {
  it('D3 retains only the latest 100 of 1,000 handler errors in delivery order', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();
    const thrown = Array.from({ length: 1_000 }, (_, i) => new Error(`failure-${i}`));
    let calls = 0;
    await backplane.subscribe(() => {
      throw thrown[calls++];
    });
    try {
      for (let i = 0; i < 1_000; i++) broker.deliver(FRAME);
      expect(calls).toBe(1_000);
      expect(backplane.handlerErrors).toHaveLength(100);
      expect(backplane.handlerErrors).toEqual(thrown.slice(-100));
    } finally {
      await backplane.close();
    }
  });

  it('continues delivering after a handler throws, and records the error', async () => {
    const broker = new FakeBroker();
    const backplane = new MessagingBackplane(broker, 'node-a', 'realtime');
    await backplane.connect();

    const reached: string[] = [];
    await backplane.subscribe(() => {
      throw new Error('consumer blew up');
    });
    await backplane.subscribe(() => reached.push('second'));

    // Runs inside the broker's delivery callback — a throw there is unhandled.
    broker.deliver(FRAME);

    expect(reached).toEqual(['second']);
    expect(backplane.handlerErrors.map((e) => e.message)).toEqual(['consumer blew up']);
    await backplane.close();
  });
});

describe('MessagingBackplane isHealthy (M90b / X21-1)', () => {
  /**
   * A broker whose `isHealthy` READS INSTANCE STATE — the shape the
   * detached-reference defect could not survive: capturing
   * `const probe = broker.isHealthy` and calling `probe()` throws a bare
   * `TypeError`, which a health endpoint reports as an error instead of a
   * fact.
   */
  class BrokerWithStatefulProbe extends FakeBroker {
    #reachable = true;
    isHealthy(): Promise<boolean> {
      return Promise.resolve(this.#reachable);
    }
    setReachable(value: boolean): void {
      this.#reachable = value;
    }
  }

  it('delegates through the OWNER, so a stateful broker probe resolves', async () => {
    const broker = new BrokerWithStatefulProbe();
    const backplane = new MessagingBackplane(broker, 'origin-a', 'frames');
    expect(typeof backplane.isHealthy).toBe('function');
    await expect(backplane.isHealthy!()).resolves.toBe(true);
  });

  it('retains the live broker state: a later outage is reported, not cached', async () => {
    const broker = new BrokerWithStatefulProbe();
    const backplane = new MessagingBackplane(broker, 'origin-a', 'frames');
    await expect(backplane.isHealthy!()).resolves.toBe(true);
    broker.setReachable(false);
    await expect(backplane.isHealthy!()).resolves.toBe(false);
  });

  it('stays undefined when the broker has no probe — unknown, not false', () => {
    const backplane = new MessagingBackplane(new FakeBroker(), 'origin-a', 'frames');
    expect(backplane.isHealthy).toBeUndefined();
  });
});

describe('messaging backplane independent delivery and frame age', () => {
  it.each([false, true])(
    'preserves a refused subscription cleanup failure, closed=%s',
    async (closed) => {
      const broker = new FakeBroker();
      const cause = new Error('cleanup-secret');
      vi.spyOn(broker, 'subscribe').mockResolvedValue({ unsubscribe: () => Promise.reject(cause) });
      const plane = new MessagingBackplane(broker, 'a', 'frames');
      const opening = plane.connect();
      if (closed) await plane.close();
      const refusal = await opening.catch((error: unknown) => error);
      if (closed) expect(refusal).toBe(cause);
      else {
        expect(refusal).toBeInstanceOf(Error);
        expect((refusal as Error).name).toBe('BackplaneFanOutUnsupportedError');
        expect((refusal as Error).cause).toBe(cause);
        expect((refusal as Error).message).not.toContain('cleanup-secret');
      }
      await plane.close();
    },
  );
  it('rejects a synchronously throwing broker subscribe through the promise contract', async () => {
    const broker = new FakeBroker();
    const cause = new Error('subscribe failed');
    vi.spyOn(broker, 'subscribe').mockImplementation(() => {
      throw cause;
    });
    await expect(new MessagingBackplane(broker, 'a', 'frames').connect()).rejects.toBe(cause);
  });
  it('requests fanOut and refuses an unconfirmed competing subscription', async () => {
    const broker = new FakeBroker();
    const unsubscribe = vi.fn(() => Promise.resolve());
    const subscribe = vi.spyOn(broker, 'subscribe').mockResolvedValue({ unsubscribe });
    const backplane = new MessagingBackplane(broker, 'a', 'frames');
    await expect(backplane.connect()).rejects.toThrow('competing subscription');
    expect(subscribe).toHaveBeenCalledWith('frames', expect.any(Function), { fanOut: true });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await backplane.close();
  });

  it.each([0, 100])(
    'stamps outgoing frames and applies maxFrameAgeMs=%s before dispatch',
    async (max) => {
      const broker = new FakeBroker();
      let now = 0;
      const warn = vi.fn();
      const backplane = new MessagingBackplane(
        broker,
        'node-a',
        'frames',
        { failed: vi.fn(), succeeded: vi.fn(), warn },
        () => now,
        max,
      );
      await backplane.connect();
      await backplane.publish({ ...FRAME, origin: 'node-a' });
      expect(broker.published[0]!.message).toEqual({ ...FRAME, origin: 'node-a', sentAtMs: 0 });
      const delivered = vi.fn();
      await backplane.subscribe(delivered);
      now = 1000;
      broker.deliver({ ...FRAME, sentAtMs: 0 });
      expect(delivered).toHaveBeenCalledTimes(max === 0 ? 1 : 0);
      broker.deliver({ ...FRAME, sentAtMs: now });
      expect(delivered).toHaveBeenLastCalledWith(FRAME);
      expect(warn).toHaveBeenCalledTimes(max === 0 ? 0 : 2);
      vi.spyOn(broker, 'publish').mockRejectedValueOnce(new Error('remote-secret'));
      await expect(backplane.publish(FRAME)).rejects.toThrow('remote-secret');
      expect(warn.mock.calls.at(-1)![0]).toContain('may still arrive late');
      await backplane.close();
    },
  );

  it('coalesces pending opens and closes a handle arriving after close', async () => {
    const broker = new FakeBroker();
    const pending = Promise.withResolvers<ISubscription>();
    vi.spyOn(broker, 'subscribe').mockReturnValueOnce(pending.promise);
    const backplane = new MessagingBackplane(broker, 'a', 'frames');
    const a = backplane.connect();
    const b = backplane.connect();
    expect(b).toBe(a);
    await backplane.close();
    const unsubscribe = vi.fn(() => Promise.resolve());
    pending.resolve({ fanOut: true, unsubscribe });
    await a;
    expect(unsubscribe).toHaveBeenCalledOnce();
    await backplane.connect();
    await backplane.close();
  });
});
