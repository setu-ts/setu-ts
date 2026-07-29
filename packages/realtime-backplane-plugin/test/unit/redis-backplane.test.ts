/**
 * Tests for the Redis pub/sub backplane transport.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RealtimeFrame } from '@hono-enterprise/common';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';
import type { IRedisBackplaneClient, IRedisModule } from '../../src/interfaces/index.ts';

/**
 * A client fake honoring the real Redis behavior that matters here: a
 * connection is either a publisher or a subscriber, never both. `publish` on a
 * client that has subscribed throws, exactly as a real Redis connection in
 * subscriber mode rejects the command — a fake without this would let the
 * two-connection bug pass.
 */
class FakeRedisClient implements IRedisBackplaneClient {
  readonly published: Array<{ channel: string; message: string }> = [];
  readonly subscribed: string[] = [];
  quitCount = 0;
  #listeners: Array<(channel: string, message: string) => void> = [];
  #inSubscriberMode = false;

  publish(channel: string, message: string): Promise<number> {
    if (this.#inSubscriberMode) {
      return Promise.reject(
        new Error("ERR Can't execute 'publish': only (P|S)SUBSCRIBE / ... are allowed"),
      );
    }
    this.published.push({ channel, message });
    return Promise.resolve(1);
  }

  subscribe(channel: string): Promise<unknown> {
    this.#inSubscriberMode = true;
    this.subscribed.push(channel);
    return Promise.resolve(1);
  }

  unsubscribe(channel: string): Promise<unknown> {
    this.subscribed.splice(this.subscribed.indexOf(channel), 1);
    return Promise.resolve(0);
  }

  on(event: string, listener: (channel: string, message: string) => void): void {
    if (event === 'message') {
      this.#listeners.push(listener);
    }
  }

  off(event: string, listener: (channel: string, message: string) => void): void {
    if (event === 'message') {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    }
  }

  quit(): Promise<unknown> {
    this.quitCount++;
    return Promise.resolve('OK');
  }

  /** Simulates a pub/sub message arriving on this connection. */
  emit(channel: string, message: string): void {
    for (const listener of this.#listeners) {
      listener(channel, message);
    }
  }
}

const FRAME: RealtimeFrame = { kind: 'ws-room', origin: 'node-b', name: 'lobby', data: 'hi' };

describe('RedisBackplane construction', () => {
  it('rejects a client injected without a subscriber', () => {
    expect(() =>
      new RedisBackplane(
        { transport: 'redis', client: new FakeRedisClient() },
        'node-a',
        'realtime',
      )
    ).toThrow(/BOTH options.client and options.subscriber/);
  });

  it('rejects a subscriber injected without a client', () => {
    expect(() =>
      new RedisBackplane(
        { transport: 'redis', subscriber: new FakeRedisClient() },
        'node-a',
        'realtime',
      )
    ).toThrow(/BOTH options.client and options.subscriber/);
  });

  it('rejects a configuration with neither clients nor a url', () => {
    expect(() => new RedisBackplane({ transport: 'redis' }, 'node-a', 'realtime')).toThrow(
      /requires options.url/,
    );
  });

  it('rejects an empty url', () => {
    expect(() => new RedisBackplane({ transport: 'redis', url: '' }, 'node-a', 'realtime'))
      .toThrow(/requires options.url/);
  });
});

describe('RedisBackplane', () => {
  it('subscribes on the subscriber connection and publishes on the publisher', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );

    await backplane.connect();
    await backplane.publish(FRAME);

    // The publish must land on the publisher; routing it to the subscriber
    // would have rejected, since that connection is in subscriber mode.
    expect(subscriber.subscribed).toEqual(['realtime']);
    expect(client.published).toEqual([
      { channel: 'realtime', message: JSON.stringify(FRAME) },
    ]);
    expect(subscriber.published).toEqual([]);
    await backplane.close();
  });

  it('delivers an arriving frame to its handlers', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));
    subscriber.emit('realtime', JSON.stringify(FRAME));

    expect(received).toEqual([FRAME]);
    await backplane.close();
  });

  it('ignores traffic on another channel', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));
    subscriber.emit('some-other-channel', JSON.stringify(FRAME));

    expect(received).toEqual([]);
    await backplane.close();
  });

  it('drops own-origin, unparseable, and malformed messages', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));

    // A Redis channel is shared infrastructure; none of these may throw inside
    // the driver's listener, where nothing would catch it.
    subscriber.emit('realtime', 'not json{');
    subscriber.emit('realtime', JSON.stringify({ kind: 'nope' }));
    subscriber.emit('realtime', JSON.stringify({ ...FRAME, origin: 'node-a' }));
    subscriber.emit('realtime', JSON.stringify(FRAME));

    expect(received).toEqual([FRAME]);
    await backplane.close();
  });

  it('builds both clients from the module when none are injected', async () => {
    const built: string[] = [];
    const clients: FakeRedisClient[] = [];
    const module: IRedisModule = {
      create: (url: string): IRedisBackplaneClient => {
        built.push(url);
        const client = new FakeRedisClient();
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    await backplane.connect();

    // Two connections, not one — the protocol constraint made structural.
    expect(built).toEqual(['redis://localhost:6379', 'redis://localhost:6379']);
    expect(clients.length).toBe(2);
    await backplane.publish(FRAME);
    expect(clients[0]?.published.length).toBe(1);
    await backplane.close();
  });

  it('is idempotent on connect', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();
    await backplane.connect();
    expect(subscriber.subscribed).toEqual(['realtime']);
    await backplane.close();
  });

  it('unsubscribes, detaches its listener, and quits both connections on close', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();

    const received: RealtimeFrame[] = [];
    await backplane.subscribe((f) => received.push(f));
    await backplane.close();

    expect(subscriber.subscribed).toEqual([]);
    expect(subscriber.quitCount).toBe(1);
    expect(client.quitCount).toBe(1);

    // The listener is detached, so late traffic reaches nothing.
    subscriber.emit('realtime', JSON.stringify(FRAME));
    expect(received).toEqual([]);
  });

  it('tolerates a close before connect', async () => {
    const backplane = new RedisBackplane(
      { transport: 'redis', client: new FakeRedisClient(), subscriber: new FakeRedisClient() },
      'node-a',
      'realtime',
    );
    await backplane.close();
  });

  it('publishing before connect is a no-op rather than a throw', async () => {
    const backplane = new RedisBackplane(
      { transport: 'redis', client: new FakeRedisClient(), subscriber: new FakeRedisClient() },
      'node-a',
      'realtime',
    );
    await backplane.publish(FRAME);
  });
});
