import { EventEmitter } from 'node:events';
/**
 * Tests for the Redis pub/sub backplane transport.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import type { ConnectionErrorReporter, RealtimeFrame } from '@setu-ts/common';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';
import type { IRedisBackplaneClient, IRedisModule } from '../../src/interfaces/index.ts';
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS } from '../../src/interfaces/index.ts';

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
  /** When set, `subscribe` rejects with this and does not enter subscriber mode. */
  failSubscribe: Error | undefined;
  /** When set, `quit` rejects with this — a connection that will not close cleanly. */
  failQuit: Error | undefined;
  /** When set, `unsubscribe` rejects with this. */
  failUnsubscribe: Error | undefined;
  #listeners: Array<(channel: string, message: string) => void> = [];
  #inSubscriberMode = false;
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;

  /**
   * Holds every subsequent `subscribe` until the returned function runs, so a
   * test can observe an open that is genuinely still in flight.
   *
   * @returns Releases the held subscribe
   */
  holdSubscribe(): () => void {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return () => this.#release?.();
  }

  /** Whether SUBSCRIBE has succeeded on this connection. */
  get inSubscriberMode(): boolean {
    return this.#inSubscriberMode;
  }

  /** How many listeners are currently attached to `message`. */
  get listenerCount(): number {
    return this.#listeners.length;
  }

  publish(channel: string, message: string): Promise<number> {
    if (this.#inSubscriberMode) {
      return Promise.reject(
        new Error("ERR Can't execute 'publish': only (P|S)SUBSCRIBE / ... are allowed"),
      );
    }
    this.published.push({ channel, message });
    return Promise.resolve(1);
  }

  async subscribe(channel: string): Promise<unknown> {
    if (this.#gate !== undefined) {
      await this.#gate;
    }
    if (this.failSubscribe !== undefined) {
      // A rejected SUBSCRIBE leaves the connection in normal mode, as on a real
      // server: nothing was subscribed.
      throw this.failSubscribe;
    }
    this.#inSubscriberMode = true;
    this.subscribed.push(channel);
    return 1;
  }

  unsubscribe(channel: string): Promise<unknown> {
    if (this.failUnsubscribe !== undefined) {
      return Promise.reject(this.failUnsubscribe);
    }
    this.subscribed.splice(this.subscribed.indexOf(channel), 1);
    return Promise.resolve(0);
  }

  /** Listeners for every event other than `message`, by event name. */
  readonly eventListeners = new Map<string, Array<(value: unknown) => void>>();

  on(event: string, listener: (channel: string, message: string) => void): void {
    if (event === 'message') {
      this.#listeners.push(listener);
      return;
    }
    const list = this.eventListeners.get(event) ?? [];
    list.push(listener as unknown as (value: unknown) => void);
    this.eventListeners.set(event, list);
  }

  /** Simulates the client emitting a lifecycle event (`'error'`, `'ready'`). */
  emitEvent(event: string, value?: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      listener(value);
    }
  }

  off(event: string, listener: (channel: string, message: string) => void): void {
    if (event === 'message') {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
      return;
    }
    const list = this.eventListeners.get(event);
    if (list !== undefined) {
      this.eventListeners.set(
        event,
        list.filter((l) => l !== (listener as unknown as (value: unknown) => void)),
      );
    }
  }

  quit(): Promise<unknown> {
    this.quitCount++;
    if (this.failQuit !== undefined) {
      return Promise.reject(this.failQuit);
    }
    return Promise.resolve('OK');
  }

  disconnectCount = 0;
  /** When set, `disconnect` throws this. */
  failDisconnect: Error | undefined;

  /** ioredis's synchronous forced close: it stops reconnecting. */
  disconnect(): void {
    this.disconnectCount++;
    if (this.failDisconnect !== undefined) {
      throw this.failDisconnect;
    }
  }

  /** Simulates a pub/sub message arriving on this connection. */
  emit(channel: string, message: string): void {
    for (const listener of this.#listeners) {
      listener(channel, message);
    }
  }
}

const FRAME: RealtimeFrame = { kind: 'ws-room', origin: 'node-b', name: 'lobby', data: 'hi' };

/**
 * A publisher whose `publish` rejects with a caller-supplied error, standing in
 * for a transport that loses its backend mid-publish.
 */
function failingPublisher(
  failure: unknown,
  status?: string,
  onWrite?: (client: { status?: string; emit(event: string): boolean }) => void,
): IRedisBackplaneClient & EventEmitter {
  const ok = (): Promise<unknown> => Promise.resolve();
  const client = Object.assign(new EventEmitter(), {
    publish: (): Promise<never> => {
      onWrite?.(client);
      return Promise.reject(failure);
    },
    subscribe: ok,
    unsubscribe: ok,
    quit: ok,
    disconnect: () => {},
    ...(status === undefined ? {} : { status }),
  });
  return client as unknown as IRedisBackplaneClient & EventEmitter;
}
/**
 * A lost connection (ioredis \`MaxRetriesPerRequestError\`) answers 504 in
 * every client state: ioredis rejects commands already sent with the same
 * error, and a driver writes a queued command as soon as a socket opens, so no
 * state the framework can observe proves the command was never written (M131a
 * security audits).
 */
const LOST_CONNECTION_CASES = [
  ['reconnecting', false, 'reconnecting'],
  ['reconnecting', true, 'reconnecting'],
  ['reconnecting', false, 'ready'],
  ['ready', false, 'ready'],
] as const;

/** Between dispatch and failure: an optional reconnect, then the final state. */
function during(reconnect: boolean, after: string) {
  return (client: { status?: string; emit(event: string): boolean }): void => {
    if (reconnect) client.emit('connect');
    client.status = after;
  };
}

function maxRetries(): Error {
  const e = new Error(
    'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
  );
  e.name = 'MaxRetriesPerRequestError';
  return e;
}

describe('RedisBackplane.publish backend-fault wrapping (M131a X88-5)', () => {
  it.each(LOST_CONNECTION_CASES)(
    'dispatch %s, reconnect %s, failure %s → 504',
    async (before, reconnect, after) => {
      const lost = maxRetries();
      const backplane = new RedisBackplane(
        {
          transport: 'redis',
          client: failingPublisher(lost, before, during(reconnect, after)),
          subscriber: new FakeRedisClient(),
        },
        'a',
        'topic',
      );
      await backplane.connect();
      try {
        await expect(backplane.publish(FRAME)).rejects.toSatisfy((thrown: unknown) => {
          const e = thrown as Error;
          return e instanceof BackendOutcomeUnknownError && e.cause === lost;
        });
      } finally {
        await backplane.close();
      }
    },
  );

  it('keeps its error listeners through QUIT, then detaches (N-4)', async () => {
    const client = failingPublisher(new Error('unused'), 'ready');
    client.quit = (): Promise<unknown> => {
      client.emit('error', new Error('write EPIPE'));
      return Promise.resolve();
    };
    const errors: unknown[] = [];
    const backplane = new RedisBackplane(
      {
        transport: 'redis',
        client,
        subscriber: new FakeRedisClient(),
        connectionErrorReporter: { report: (e) => errors.push(e), recovered: () => {} },
      },
      'a',
      'topic',
    );
    await backplane.connect();
    await backplane.close();
    expect(errors).toHaveLength(1);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('a failed injected connect detaches its listeners (N-3)', async () => {
    const client = failingPublisher(new Error('unused'), 'wait');
    (client as unknown as { connect: () => Promise<void> }).connect = () =>
      Promise.reject(new Error('refused'));
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber: new FakeRedisClient() },
      'a',
      'topic',
    );
    await expect(backplane.connect()).rejects.toThrow('refused');
    expect(client.listenerCount('error')).toBe(0);
  });

  it('wraps a refusal before any send as BackendUnavailableError (503)', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    });
    const backplane = new RedisBackplane(
      { transport: 'redis', client: failingPublisher(refused), subscriber: new FakeRedisClient() },
      'a',
      'topic',
    );
    await backplane.connect();
    try {
      await expect(backplane.publish(FRAME)).rejects.toSatisfy(
        (thrown: unknown) => thrown instanceof BackendUnavailableError && thrown.cause === refused,
      );
    } finally {
      await backplane.close();
    }
  });

  it('wraps a sent-with-no-answer fault as BackendOutcomeUnknownError (504)', async () => {
    const timedOut = new Error('Command timed out');
    const backplane = new RedisBackplane(
      { transport: 'redis', client: failingPublisher(timedOut), subscriber: new FakeRedisClient() },
      'a',
      'topic',
    );
    await backplane.connect();
    try {
      await expect(backplane.publish(FRAME)).rejects.toSatisfy((thrown: unknown) => {
        const e = thrown as Error;
        return e instanceof BackendOutcomeUnknownError && e.cause === timedOut;
      });
    } finally {
      await backplane.close();
    }
  });
});

describe('RedisBackplane injected lazy startup', () => {
  function lazyClient(status = 'wait') {
    const client = Object.assign(new FakeRedisClient(), {
      status,
      connect: vi.fn<() => Promise<unknown>>(),
    });
    client.connect.mockImplementation(() => {
      client.status = 'ready';
      return Promise.resolve('OK');
    });
    return client;
  }

  it('connects each injected wait client exactly once before subscribing', async () => {
    const client = lazyClient();
    const subscriber = lazyClient();
    const backplane = new RedisBackplane({ transport: 'redis', client, subscriber }, 'a', 'topic');
    const subscribe = vi.spyOn(subscriber, 'subscribe').mockImplementation((channel) => {
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(subscriber.connect).toHaveBeenCalledTimes(1);
      expect([client.status, subscriber.status]).toEqual(['ready', 'ready']);
      subscriber.subscribed.push(channel);
      return Promise.resolve(1);
    });
    await Promise.all([backplane.connect(), backplane.connect()]);
    await backplane.connect();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(subscriber.connect).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledExactlyOnceWith('topic');
    await backplane.close();
  });

  it.each(['ready', 'connecting', 'reconnecting', 'end'])(
    'does not connect injected clients with status %s',
    async (status) => {
      const client = lazyClient(status);
      const subscriber = lazyClient(status);
      const backplane = new RedisBackplane(
        { transport: 'redis', client, subscriber },
        'a',
        'topic',
      );
      await backplane.connect();
      expect(client.connect).not.toHaveBeenCalled();
      expect(subscriber.connect).not.toHaveBeenCalled();
      await backplane.close();
    },
  );

  it('keeps wait clients without connect compatible', async () => {
    const client = Object.assign(new FakeRedisClient(), { status: 'wait' });
    const subscriber = Object.assign(new FakeRedisClient(), { status: 'wait' });
    const backplane = new RedisBackplane({ transport: 'redis', client, subscriber }, 'a', 'topic');
    await backplane.connect();
    expect('connect' in client).toBe(false);
    expect('connect' in subscriber).toBe(false);
    expect(subscriber.subscribed).toEqual(['topic']);
    await backplane.close();
  });

  it('does not connect clients without a status', async () => {
    const client = Object.assign(new FakeRedisClient(), {
      connect: vi.fn<() => Promise<unknown>>(),
    });
    const subscriber = Object.assign(new FakeRedisClient(), {
      connect: vi.fn<() => Promise<unknown>>(),
    });
    const backplane = new RedisBackplane({ transport: 'redis', client, subscriber }, 'a', 'topic');
    await backplane.connect();
    expect(client.connect).not.toHaveBeenCalled();
    expect(subscriber.connect).not.toHaveBeenCalled();
    await backplane.close();
  });

  it('detaches only after discarding owned connections on a failed subscribe (CodeRabbit #543)', async () => {
    const built = () =>
      Object.assign(new EventEmitter(), {
        status: 'ready',
        publish: () => Promise.resolve(1),
        subscribe: () => Promise.reject(new Error('subscribe refused')),
        unsubscribe: () => Promise.resolve(),
        disconnect: () => {},
        quit(this: EventEmitter): Promise<string> {
          // QUIT on an unreachable server: the EPIPE must still reach a listener.
          this.emit('error', new Error('write EPIPE'));
          return Promise.resolve('OK');
        },
      });
    const clients = [built(), built()];
    let next = 0;
    const module = { create: () => clients[next++] } as unknown as IRedisModule;
    const reported: unknown[] = [];
    const backplane = new RedisBackplane(
      {
        transport: 'redis',
        url: 'redis://test',
        module,
        connectionErrorReporter: { report: (e) => reported.push(e), recovered: () => {} },
      },
      'a',
      'topic',
    );
    await expect(backplane.connect()).rejects.toThrow('subscribe refused');
    expect(reported.some((e) => (e as Error).message === 'write EPIPE')).toBe(true);
    for (const client of clients) expect(client.listenerCount('error')).toBe(0);
  });

  it('does not connect clients the backplane builds even if they report wait', async () => {
    const clients = [lazyClient(), lazyClient()];
    let next = 0;
    const module: IRedisModule = { create: () => clients[next++] };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://test', module },
      'a',
      'topic',
    );
    await backplane.connect();
    for (const client of clients) expect(client.connect).not.toHaveBeenCalled();
    await backplane.close();
  });

  it.each(['publisher', 'subscriber'] as const)(
    'propagates a rejected %s connect without subscribing or closing injected clients',
    async (half) => {
      const client = lazyClient();
      const subscriber = lazyClient();
      const error = new Error('connect refused');
      (half === 'publisher' ? client : subscriber).connect.mockRejectedValueOnce(error);
      const backplane = new RedisBackplane(
        { transport: 'redis', client, subscriber },
        'a',
        'topic',
      );
      await expect(backplane.connect()).rejects.toBe(error);
      expect(subscriber.subscribed).toEqual([]);
      expect(subscriber.listenerCount).toBe(0);
      for (const connection of [client, subscriber]) {
        expect(connection.quitCount).toBe(0);
        expect(connection.disconnectCount).toBe(0);
      }
      await expect(backplane.publish(FRAME)).rejects.toThrow(
        'the redis transport is not connected',
      );
      await backplane.connect();
      expect(subscriber.subscribed).toEqual(['topic']);
      await backplane.close();
    },
  );
});

it('captures asynchronous redis subscriber errors in history and reporter', async () => {
  const client = new FakeRedisClient();
  const subscriber = new FakeRedisClient();
  const failed = vi.fn();
  const succeeded = vi.fn();
  const backplane = new RedisBackplane(
    { transport: 'redis', client, subscriber },
    'node-a',
    'realtime',
    { failed, succeeded },
  );
  const error = new Error('async redis');
  const bad = async (): Promise<void> => {
    await Promise.resolve();
    throw error;
  };
  await backplane.connect();
  try {
    await backplane.subscribe(bad);
    subscriber.emit('realtime', JSON.stringify(FRAME));
    await setImmediate();
    expect(backplane.handlerErrors).toEqual([error]);
    expect(failed).toHaveBeenCalledExactlyOnceWith(bad, error, FRAME);
  } finally {
    await backplane.close();
  }
});

it('D3 retains only the latest 100 of 1,000 Redis handler errors in delivery order', async () => {
  const client = new FakeRedisClient();
  const subscriber = new FakeRedisClient();
  const backplane = new RedisBackplane(
    { transport: 'redis', client, subscriber },
    'node-a',
    'realtime',
  );
  await backplane.connect();
  const thrown = Array.from({ length: 1_000 }, (_, i) => new Error(`failure-${i}`));
  let calls = 0;
  await backplane.subscribe(() => {
    throw thrown[calls++];
  });
  try {
    for (let i = 0; i < 1_000; i++) subscriber.emit('realtime', JSON.stringify(FRAME));
    expect(calls).toBe(1_000);
    expect(backplane.handlerErrors).toHaveLength(100);
    expect(backplane.handlerErrors).toEqual(thrown.slice(-100));
  } finally {
    await backplane.close();
  }
});

describe('RedisBackplane construction', () => {
  it('rejects a client injected without a subscriber', () => {
    expect(
      () =>
        new RedisBackplane(
          { transport: 'redis', client: new FakeRedisClient() },
          'node-a',
          'realtime',
        ),
    ).toThrow(/BOTH options.client and options.subscriber/);
  });

  it('rejects a subscriber injected without a client', () => {
    expect(
      () =>
        new RedisBackplane(
          { transport: 'redis', subscriber: new FakeRedisClient() },
          'node-a',
          'realtime',
        ),
    ).toThrow(/BOTH options.client and options.subscriber/);
  });

  it('rejects a configuration with neither clients nor a url', () => {
    expect(() => new RedisBackplane({ transport: 'redis' }, 'node-a', 'realtime')).toThrow(
      /requires options.url/,
    );
  });

  it('rejects an empty url', () => {
    expect(() => new RedisBackplane({ transport: 'redis', url: '' }, 'node-a', 'realtime')).toThrow(
      /requires options.url/,
    );
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
    expect(client.published).toEqual([{ channel: 'realtime', message: JSON.stringify(FRAME) }]);
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

  it('bounds both built clients with the default command timeout', async () => {
    const options: Array<Parameters<IRedisModule['create']>[1]> = [];
    const module: IRedisModule = {
      create: (_url, clientOptions): IRedisBackplaneClient => {
        options.push(clientOptions);
        return new FakeRedisClient();
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    await backplane.connect();

    // Publisher first, without an offline queue (M139f X3-3); the subscriber
    // keeps the default.
    expect(options).toEqual([
      { commandTimeout: DEFAULT_REDIS_COMMAND_TIMEOUT_MS, enableOfflineQueue: false },
      { commandTimeout: DEFAULT_REDIS_COMMAND_TIMEOUT_MS },
    ]);
    await backplane.close();
  });

  it('forwards a configured command timeout, and 0 leaves the clients unbounded', async () => {
    for (const [commandTimeoutMs, expected] of [
      [250, { commandTimeout: 250 }],
      [0, {}],
    ] as const) {
      const options: Array<Parameters<IRedisModule['create']>[1]> = [];
      const module: IRedisModule = {
        create: (_url, clientOptions): IRedisBackplaneClient => {
          options.push(clientOptions);
          return new FakeRedisClient();
        },
      };
      const backplane = new RedisBackplane(
        { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs },
        'node-a',
        'realtime',
      );
      await backplane.connect();
      expect(options).toEqual([{ ...expected, enableOfflineQueue: false }, expected]);
      await backplane.close();
    }
  });

  it('accepts the largest timer delay as a command timeout', () => {
    expect(
      () =>
        new RedisBackplane(
          { transport: 'redis', url: 'redis://localhost:6379', commandTimeoutMs: 2_147_483_647 },
          'node-a',
          'realtime',
        ),
    ).not.toThrow();
  });

  it('refuses a command timeout outside 0 to 2147483647', () => {
    // 2^31 overflows the runtime timer, which then fires after 1 ms: measured
    // against a real Redis, every publish failed with `Command timed out`.
    for (const commandTimeoutMs of [
      Number.NaN,
      -1,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
      3_000_000_000,
      '5' as never,
    ]) {
      expect(
        () =>
          new RedisBackplane(
            { transport: 'redis', url: 'redis://localhost:6379', commandTimeoutMs },
            'node-a',
            'realtime',
          ),
      ).toThrow(RangeError);
    }
  });

  it('refuses a bad command timeout without echoing or converting it', () => {
    // A mis-assigned secret must not reach the log through the refusal, and a
    // hostile value's own code must not run inside validation.
    let converted = 0;
    const hostile = {
      toString: () => {
        converted++;
        throw new Error('toString ran');
      },
    };
    for (const commandTimeoutMs of ['secret-canary\r\nforged', hostile] as never[]) {
      let caught: unknown;
      try {
        new RedisBackplane(
          { transport: 'redis', url: 'redis://localhost:6379', commandTimeoutMs },
          'node-a',
          'realtime',
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RangeError);
      expect((caught as Error).message).not.toContain('secret-canary');
      expect((caught as Error).message).not.toContain('forged');
    }
    expect(converted).toBe(0);
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

  it('rejects a publish before connect rather than reporting it sent', async () => {
    const client = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber: new FakeRedisClient() },
      'node-a',
      'realtime',
    );
    // Resolving here would tell the WebSocket and SSE consumers — and an
    // observed publish — that a frame reached Redis when nothing was sent.
    await expect(backplane.publish(FRAME)).rejects.toThrow('the redis transport is not connected');
    expect(client.published).toEqual([]);
  });

  it('rejects a publish after close', async () => {
    const client = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber: new FakeRedisClient() },
      'node-a',
      'realtime',
    );
    await backplane.connect();
    await backplane.publish(FRAME);
    await backplane.close();

    await expect(backplane.publish(FRAME)).rejects.toThrow('the redis transport is not connected');
    expect(client.published.length).toBe(1);
  });
});

describe('RedisBackplane connect', () => {
  it('makes a second connect await the in-flight open rather than returning early', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const release = subscriber.holdSubscribe();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );

    let secondSettled = false;
    const first = backplane.connect();
    const second = backplane.connect().then(() => {
      secondSettled = true;
    });
    // Drain the microtask queue: the early-return path resolves within it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Neither call may resolve while SUBSCRIBE is still outstanding — a caller
    // that returns here would publish into a channel nobody is listening on.
    expect(subscriber.inSubscriberMode).toBe(false);
    expect(secondSettled).toBe(false);

    release();
    await Promise.all([first, second]);

    expect(subscriber.inSubscriberMode).toBe(true);
    expect(subscriber.subscribed).toEqual(['realtime']);
    expect(subscriber.listenerCount).toBe(1);
    await backplane.close();
  });

  it('quits the publisher when building the subscriber throws', async () => {
    const clients: FakeRedisClient[] = [];
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        if (clients.length === 1) {
          throw new Error('ECONNREFUSED');
        }
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

    await expect(backplane.connect()).rejects.toThrow('ECONNREFUSED');

    // The publisher was already live when the second construction failed, and
    // no field references it — leaving it open leaks a socket per attempt.
    expect(clients.length).toBe(1);
    expect(clients[0]?.quitCount).toBe(1);
  });

  it('quits both connections it built when SUBSCRIBE rejects, and stays unconnected', async () => {
    const clients: FakeRedisClient[] = [];
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        client.failSubscribe = new Error('SUBSCRIBE refused');
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    await expect(backplane.connect()).rejects.toThrow('SUBSCRIBE refused');

    expect(clients.map((c) => c.quitCount)).toEqual([1, 1]);
    expect(clients[1]?.listenerCount).toBe(0);
    // A half-built attempt must not read as a connection.
    await expect(backplane.publish(FRAME)).rejects.toThrow('the redis transport is not connected');
    expect(clients[0]?.published).toEqual([]);
  });

  it('leaves injected connections open when SUBSCRIBE rejects', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    subscriber.failSubscribe = new Error('SUBSCRIBE refused');
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );

    await expect(backplane.connect()).rejects.toThrow('SUBSCRIBE refused');

    // These belong to the caller, who may retry or close them.
    expect(client.quitCount).toBe(0);
    expect(subscriber.quitCount).toBe(0);
    expect(subscriber.listenerCount).toBe(0);
  });

  it('reports the open failure even when the rollback quit also fails', async () => {
    const clients: FakeRedisClient[] = [];
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        client.failSubscribe = new Error('SUBSCRIBE refused');
        client.failQuit = new Error('quit blew up');
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    await expect(backplane.connect()).rejects.toThrow('SUBSCRIBE refused');
    expect(clients.map((c) => c.quitCount)).toEqual([1, 1]);
  });

  it('retries the open after a failed attempt', async () => {
    const clients: FakeRedisClient[] = [];
    let breakSubscribe = true;
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        if (breakSubscribe) {
          client.failSubscribe = new Error('SUBSCRIBE refused');
        }
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    await expect(backplane.connect()).rejects.toThrow('SUBSCRIBE refused');

    // The memoized attempt is cleared on failure, so this builds a fresh pair
    // rather than re-awaiting the rejection forever.
    breakSubscribe = false;
    await backplane.connect();

    expect(clients.length).toBe(4);
    expect(clients[3]?.subscribed).toEqual(['realtime']);
    await backplane.publish(FRAME);
    expect(clients[2]?.published.length).toBe(1);
    await backplane.close();
  });

  it('reopens after a close', async () => {
    const clients: FakeRedisClient[] = [];
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
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
    await backplane.close();
    await backplane.connect();

    expect(clients.length).toBe(4);
    expect(clients[3]?.subscribed).toEqual(['realtime']);
    await backplane.close();
  });
});

describe('RedisBackplane close racing an open', () => {
  /** A module whose second-built connection holds its SUBSCRIBE until released. */
  function gatedModule(): {
    module: IRedisModule;
    clients: FakeRedisClient[];
    release: () => void;
  } {
    const clients: FakeRedisClient[] = [];
    let release = (): void => {};
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        // The subscriber is the second connection built.
        if (clients.length === 1) {
          release = client.holdSubscribe();
        }
        clients.push(client);
        return client;
      },
    };
    return { module, clients, release: () => release() };
  }

  it('retires the connections it built when close lands mid-open', async () => {
    const { module, clients, release } = gatedModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    const connecting = backplane.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Shutdown arrives while SUBSCRIBE is still outstanding, so close() sees no
    // fields to clean up — the open itself must not hand its work over.
    await backplane.close();
    release();
    await connecting;

    expect(clients.map((c) => c.quitCount)).toEqual([1, 1]);
    expect(clients[1]?.subscribed).toEqual([]);
    expect(clients[1]?.listenerCount).toBe(0);

    // The backplane is closed, not connected: publishing reaches nothing, and
    // says so.
    await expect(backplane.publish(FRAME)).rejects.toThrow('the redis transport is not connected');
    expect(clients[0]?.published).toEqual([]);
  });

  it('leaves injected connections to the caller when close lands mid-open', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const release = subscriber.holdSubscribe();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );

    const connecting = backplane.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backplane.close();
    release();
    await connecting;

    // Ours to undo: the subscription and the listener. Not ours to close: the
    // connections themselves.
    expect(subscriber.subscribed).toEqual([]);
    expect(subscriber.listenerCount).toBe(0);
    expect(subscriber.quitCount).toBe(0);
    expect(client.quitCount).toBe(0);
  });

  it('still retires the pair when the rollback unsubscribe fails', async () => {
    const { module, clients, release } = gatedModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    const connecting = backplane.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const subscriber = clients[1];
    if (subscriber !== undefined) {
      subscriber.failUnsubscribe = new Error('connection already gone');
    }

    await backplane.close();
    release();
    // The retirement is best-effort: a failed UNSUBSCRIBE must not surface as a
    // rejected connect() on what is already a shutdown path.
    await connecting;

    expect(clients.map((c) => c.quitCount)).toEqual([1, 1]);
  });

  it('reopens cleanly after a close superseded an open', async () => {
    const { module, clients, release } = gatedModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    const connecting = backplane.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backplane.close();
    release();
    await connecting;

    await backplane.connect();

    expect(clients.length).toBe(4);
    expect(clients[3]?.subscribed).toEqual(['realtime']);
    await backplane.publish(FRAME);
    expect(clients[2]?.published.length).toBe(1);
    await backplane.close();
  });

  it('a superseded attempt failing later does not clear the live memo', async () => {
    const clients: FakeRedisClient[] = [];
    let release = (): void => {};
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        // Only the first attempt's subscriber is gated, and it fails when let go.
        if (clients.length === 1) {
          client.failSubscribe = new Error('SUBSCRIBE refused');
          release = client.holdSubscribe();
        }
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    const first = backplane.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backplane.close();

    // A fresh open installs a new memo while the first attempt is still pending.
    await backplane.connect();
    expect(clients.length).toBe(4);

    release();
    await expect(first).rejects.toThrow('SUBSCRIBE refused');

    // The stale rejection must not retract the live attempt's memo, or the next
    // connect() would open a third pair alongside the connected one.
    await backplane.connect();
    expect(clients.length).toBe(4);
    await backplane.close();
  });
});

describe('RedisBackplane handler isolation', () => {
  it('continues delivering after a handler throws, and never throws into the driver', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();

    const reached: string[] = [];
    await backplane.subscribe(() => {
      throw new Error('consumer blew up');
    });
    await backplane.subscribe(() => reached.push('second'));

    // `emit` stands in for ioredis dispatching its `message` event; a throw
    // escaping here would be unhandled inside the driver.
    expect(() => subscriber.emit('realtime', JSON.stringify(FRAME))).not.toThrow();
    expect(reached).toEqual(['second']);
    expect(backplane.handlerErrors.map((e) => e.message)).toEqual(['consumer blew up']);
    await backplane.close();
  });
});

describe('RedisBackplane close during an outage', () => {
  async function connected() {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber },
      'node-a',
      'realtime',
    );
    await backplane.connect();
    return { backplane, client, subscriber };
  }

  it('still quits both connections when UNSUBSCRIBE rejects, then reports it', async () => {
    const { backplane, client, subscriber } = await connected();
    const timedOut = new Error('Command timed out');
    subscriber.failUnsubscribe = timedOut;

    // Stopping at the rejected UNSUBSCRIBE left both real connections
    // reconnecting after shutdown; every step must still run.
    await expect(backplane.close()).rejects.toBe(timedOut);
    expect([subscriber.quitCount, client.quitCount]).toEqual([1, 1]);
    expect([subscriber.disconnectCount, client.disconnectCount]).toEqual([0, 0]);
  });

  it('force-disconnects a connection whose QUIT fails and still closes the other', async () => {
    const { backplane, client, subscriber } = await connected();
    const subscriberQuit = new Error('subscriber quit timed out');
    subscriber.failQuit = subscriberQuit;
    client.failQuit = new Error('publisher quit timed out');

    await expect(backplane.close()).rejects.toBe(subscriberQuit);
    expect([subscriber.disconnectCount, client.disconnectCount]).toEqual([1, 1]);
    expect(client.quitCount).toBe(1);
  });

  it('reports a failing disconnect without skipping the other connection', async () => {
    const { backplane, client, subscriber } = await connected();
    subscriber.failQuit = new Error('quit timed out');
    subscriber.failDisconnect = new Error('disconnect failed');

    await expect(backplane.close()).rejects.toThrow('quit timed out');
    expect(client.quitCount).toBe(1);
  });

  it('leaves a client without disconnect as QUIT left it', async () => {
    const { backplane, client, subscriber } = await connected();
    Object.assign(subscriber, { disconnect: undefined });
    subscriber.failQuit = new Error('quit timed out');

    await expect(backplane.close()).rejects.toThrow('quit timed out');
    expect(client.quitCount).toBe(1);
  });

  it('resolves when every step succeeds', async () => {
    const { backplane, client, subscriber } = await connected();
    await backplane.close();
    expect([subscriber.quitCount, client.quitCount]).toEqual([1, 1]);
    expect([subscriber.disconnectCount, client.disconnectCount]).toEqual([0, 0]);
  });
});

describe('RedisBackplane rollback of a failed open', () => {
  it('force-disconnects the connections it built when their rollback QUIT also fails', async () => {
    // A SUBSCRIBE that timed out is followed by a QUIT that fails the same
    // way; without the disconnect() fallback those owned connections keep
    // reconnecting after connect() has already rejected.
    const clients: FakeRedisClient[] = [];
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        client.failQuit = new Error('quit timed out');
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );
    const subscribeFailure = new Error('Command timed out');
    const original = module.create;
    module.create = (url, options) => {
      const client = original(url, options) as FakeRedisClient;
      if (clients.length === 2) {
        client.failSubscribe = subscribeFailure;
      }
      return client;
    };

    // The open's own failure is what the caller sees, not the rollback's.
    await expect(backplane.connect()).rejects.toBe(subscribeFailure);
    expect(clients.map((c) => [c.quitCount, c.disconnectCount])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('force-disconnects the connections when close lands mid-open and their QUIT fails', async () => {
    const clients: FakeRedisClient[] = [];
    let release: (() => void) | undefined;
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = new FakeRedisClient();
        client.failQuit = new Error('quit timed out');
        if (clients.length === 1) {
          release = client.holdSubscribe();
        }
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    const connecting = backplane.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await backplane.close();
    release?.();
    await connecting;

    expect(clients.map((c) => [c.quitCount, c.disconnectCount])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});

describe('RedisBackplane connection-error reporting', () => {
  /** A reporter that records what it was told. */
  function recordingReporter(): ConnectionErrorReporter & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      report: (error: unknown) => calls.push(`report:${(error as Error).message}`),
      recovered: () => calls.push('recovered'),
    };
  }

  function builtPair(): { module: IRedisModule; clients: FakeRedisClient[] } {
    const clients: FakeRedisClient[] = [];
    return {
      clients,
      module: {
        create: (): IRedisBackplaneClient => {
          const client = new FakeRedisClient();
          clients.push(client);
          return client;
        },
      },
    };
  }

  it("routes both built connections' error and ready events to the reporter", async () => {
    const { module, clients } = builtPair();
    const reporter = recordingReporter();
    const backplane = new RedisBackplane(
      {
        transport: 'redis',
        url: 'redis://localhost:6379',
        module,
        connectionErrorReporter: reporter,
      },
      'node-a',
      'realtime',
    );

    await backplane.connect();
    const [publisher, subscriber] = clients;
    publisher.emitEvent('error', new Error('refused'));
    subscriber.emitEvent('error', new Error('refused'));
    subscriber.emitEvent('ready');

    expect(publisher.eventListeners.get('error')?.length).toBe(1);
    expect(subscriber.eventListeners.get('error')?.length).toBe(1);
    expect(reporter.calls).toEqual(['report:refused', 'report:refused', 'recovered']);
    await backplane.close();
  });

  it('attaches dropping listeners to built connections when no reporter is configured', async () => {
    const { module, clients } = builtPair();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module },
      'node-a',
      'realtime',
    );

    await backplane.connect();

    // A listener must exist, or ioredis writes every error to the console.
    for (const client of clients) {
      expect(client.eventListeners.get('error')?.length).toBe(1);
      expect(() => client.emitEvent('error', new Error('refused'))).not.toThrow();
    }
    await backplane.close();
  });

  it('attaches to an injected pair when a reporter is configured (M131a X88-3)', async () => {
    const client = new FakeRedisClient();
    const subscriber = new FakeRedisClient();
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber, connectionErrorReporter: recordingReporter() },
      'node-a',
      'realtime',
    );

    await backplane.connect();

    // One reporter for both: an injected client's outages must be as visible as
    // a built one's, so the error/ready listeners are attached to the pair.
    expect(client.eventListeners.has('error')).toBe(true);
    expect(subscriber.eventListeners.has('error')).toBe(true);
    await backplane.close();
  });
});

describe('RedisBackplane owned publisher readiness (M139f X3-3)', () => {
  /** A module whose publisher starts `connecting` and the subscriber `ready`. */
  function connectingModule(): {
    module: IRedisModule;
    clients: Array<FakeRedisClient & { status: string }>;
  } {
    const clients: Array<FakeRedisClient & { status: string }> = [];
    return {
      clients,
      module: {
        create: (): IRedisBackplaneClient => {
          const client = Object.assign(new FakeRedisClient(), {
            status: clients.length === 0 ? 'connecting' : 'ready',
          });
          clients.push(client);
          return client;
        },
      },
    };
  }

  it('waits for the publisher to be ready before the pair is handed out', async () => {
    const { module, clients } = connectingModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
      'node-a',
      'realtime',
    );
    let open = false;
    const connecting = backplane.connect().then(() => {
      open = true;
    });
    await setImmediate();
    expect(open).toBe(false);
    const publisher = clients[0]!;
    // The connection watch's own `'ready'` listener, plus the open's wait.
    expect(publisher.eventListeners.get('ready')).toHaveLength(2);

    publisher.status = 'ready';
    publisher.emitEvent('ready');
    await connecting;
    expect(open).toBe(true);
    // The wait's one-shot listener is gone once it fired; the watch's stays.
    expect(publisher.eventListeners.get('ready')).toHaveLength(1);
    await backplane.publish(FRAME);
    expect(publisher.published).toHaveLength(1);
    await backplane.close();
  });

  it('refuses the open at the command timeout and closes both connections', async () => {
    const { module, clients } = connectingModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 20 },
      'node-a',
      'realtime',
    );
    const error: unknown = await backplane.connect().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect((error as Error).message).toContain('realtime-backplane-plugin: redis transport');
    expect(((error as Error).cause as Error).message).toBe(
      'the publisher was not ready within 20 ms',
    );
    expect(clients[0]!.eventListeners.get('ready')).toHaveLength(0);
    expect(clients.map((client) => client.quitCount)).toEqual([1, 1]);
  });

  it.each(['ready', 'wait', 'end'])(
    'does not wait on a built publisher whose status is %s',
    async (status) => {
      const clients: FakeRedisClient[] = [];
      const module: IRedisModule = {
        create: (): IRedisBackplaneClient => {
          const client = Object.assign(new FakeRedisClient(), { status });
          clients.push(client);
          return client;
        },
      };
      const backplane = new RedisBackplane(
        { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
        'node-a',
        'realtime',
      );
      await backplane.connect();
      // Only the connection watch listens; the open added no wait.
      expect(clients[0]!.eventListeners.get('ready')).toHaveLength(1);
      await backplane.close();
    },
  );

  it('ends an unbounded wait on close() and retires the pair (M139f audit L1)', async () => {
    const { module, clients } = connectingModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
      'node-a',
      'realtime',
    );
    const connecting = backplane.connect();
    await setImmediate();
    expect(clients[0]!.eventListeners.get('ready')).toHaveLength(2);

    await backplane.close();
    // The open sees it was superseded and releases both connections itself.
    await connecting;
    expect(clients.map((client) => client.quitCount)).toEqual([1, 1]);
    expect(clients[0]!.eventListeners.get('ready')).toHaveLength(0);
    await expect(backplane.publish(FRAME)).rejects.toThrow();
  });

  it('does not start a wait after a close() that landed during SUBSCRIBE (M139f re-audit N2)', async () => {
    const clients: Array<FakeRedisClient & { status: string }> = [];
    let release: (() => void) | undefined;
    const module: IRedisModule = {
      create: (): IRedisBackplaneClient => {
        const client = Object.assign(new FakeRedisClient(), {
          status: clients.length === 0 ? 'reconnecting' : 'ready',
        });
        if (clients.length === 1) release = client.holdSubscribe();
        clients.push(client);
        return client;
      },
    };
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
      'node-a',
      'realtime',
    );
    const connecting = backplane.connect();
    await setImmediate();
    await backplane.close();
    release!();
    // SUBSCRIBE completes after the close; the publisher never becomes ready,
    // yet the open settles and releases both connections.
    await connecting;
    expect(clients.map((client) => client.quitCount)).toEqual([1, 1]);
    expect(clients[0]!.eventListeners.get('ready')).toHaveLength(0);
  });

  it('settles for a close() at every microtask around the wait start (M139f re-audit N3)', async () => {
    for (let delay = 0; delay <= 14; delay++) {
      const clients: Array<FakeRedisClient & { status: string }> = [];
      let release: (() => void) | undefined;
      const module: IRedisModule = {
        create: (): IRedisBackplaneClient => {
          const client = Object.assign(new FakeRedisClient(), {
            status: clients.length === 0 ? 'reconnecting' : 'ready',
          });
          if (clients.length === 1) release = client.holdSubscribe();
          clients.push(client);
          return client;
        },
      };
      const backplane = new RedisBackplane(
        { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
        'node-a',
        'realtime',
      );
      let settled = false;
      const connecting = backplane.connect().then(() => {
        settled = true;
      });
      await setImmediate();
      release!();
      for (let tick = 0; tick < delay; tick++) await Promise.resolve();
      await backplane.close();
      await setImmediate();
      expect(settled, `close() after ${delay} microtask(s)`).toBe(true);
      await connecting;
      expect(clients.map((client) => client.quitCount)).toEqual([1, 1]);
      expect(clients[0]!.eventListeners.get('ready')).toHaveLength(0);
    }
  });

  it('fails the open when the publisher ends while it waits, even unbounded', async () => {
    const { module, clients } = connectingModule();
    const backplane = new RedisBackplane(
      { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
      'node-a',
      'realtime',
    );
    const connecting = backplane.connect().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await setImmediate();
    const publisher = clients[0]!;
    publisher.status = 'end';
    publisher.emitEvent('end');
    const error = await connecting;
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect(((error as Error).cause as Error).message).toBe(
      'the publisher connection ended before it was ready',
    );
    expect(clients.map((client) => client.quitCount)).toEqual([1, 1]);
    expect(publisher.eventListeners.get('ready')).toHaveLength(0);
    expect(publisher.eventListeners.get('end')).toHaveLength(0);
  });

  it.each(['ready', 'end'] as const)(
    're-reads the status once its listeners exist: %s without an event',
    async (later) => {
      const clients: FakeRedisClient[] = [];
      const module: IRedisModule = {
        create: (): IRedisBackplaneClient => {
          const client = new FakeRedisClient();
          if (clients.length === 0) {
            // `waitForReady` reads `connecting` and starts the wait; every later
            // read — the re-check in the wait's body — sees the new status.
            let reads = 0;
            Object.defineProperty(client, 'status', {
              get: () => (reads++ === 0 ? 'connecting' : later),
            });
          } else {
            Object.assign(client, { status: 'ready' });
          }
          clients.push(client);
          return client;
        },
      };
      const backplane = new RedisBackplane(
        { transport: 'redis', url: 'redis://localhost:6379', module, commandTimeoutMs: 0 },
        'node-a',
        'realtime',
      );
      const outcome = await backplane.connect().then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(outcome).toBe(later === 'ready' ? 'resolved' : 'rejected');
      expect(clients[0]!.eventListeners.get('end') ?? []).toHaveLength(0);
      await backplane.close();
    },
  );

  it('does not wait on an injected pair, whatever its status', async () => {
    const client = Object.assign(new FakeRedisClient(), { status: 'connecting' });
    const subscriber = Object.assign(new FakeRedisClient(), { status: 'connecting' });
    const backplane = new RedisBackplane(
      { transport: 'redis', client, subscriber, commandTimeoutMs: 0 },
      'node-a',
      'realtime',
    );
    await backplane.connect();
    // Only the connection watch listens for `'ready'`; nothing waited on it.
    expect(client.eventListeners.get('ready')).toHaveLength(1);
    await backplane.close();
  });
});
