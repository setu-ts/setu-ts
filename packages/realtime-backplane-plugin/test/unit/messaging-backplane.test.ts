/**
 * Tests for the broker-backed backplane transport and its frame guard.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  RealtimeFrame,
} from '@hono-enterprise/common';
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
