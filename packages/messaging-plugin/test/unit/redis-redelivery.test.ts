import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisStreamsBroker, validateClient } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { IntegrationEventRejectedError } from '../../src/errors.ts';
import type { RedisStreamsOptions } from '../../src/interfaces/index.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';

function setup(options: RedisStreamsOptions = {}) {
  const clock = clockRuntime();
  const client = new FakeRedisStreamsClient({ now: clock.runtime.hrtime });
  const logs: string[] = [];
  const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
    client,
    pollIntervalMs: 5,
    reclaimIntervalMs: 10,
    consumerRetry: { maxAttempts: 3, delaysMs: [20, 40] },
    logger: {
      error: (msg) => {
        logs.push(msg);
      },
    },
    ...options,
  });
  return { clock, client, broker, logs };
}

describe('Redis Streams redelivery', () => {
  it('keeps hostile thrown values within retry classification and continues the batch', async () => {
    for (const retryable of [true, false]) {
      for (const revoked of [true, false]) {
        const hostile = Proxy.revocable({}, {
          getPrototypeOf() {
            throw Error('hostile prototype trap');
          },
        });
        if (revoked) hostile.revoke();
        const { clock, client, broker, logs } = setup({
          consumerRetry: {
            maxAttempts: retryable ? 2 : 1,
            delaysMs: [20],
            isRetryable: () => retryable,
          },
        });
        let failedCalls = 0;
        const delivered: unknown[] = [];
        await broker.connect();
        await broker.subscribe('t', (message) => {
          if (message === 'failed') {
            failedCalls++;
            throw hostile.proxy;
          }
          delivered.push(message);
        });
        await broker.publish('t', 'failed');
        await broker.publish('t', 'healthy');
        await clock.advance(5);
        expect(delivered).toEqual(['healthy']);
        expect(failedCalls).toBe(1);
        expect(logs.some((m) => m.startsWith('Poll error:'))).toBe(false);
        expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10'))
          .toHaveLength(retryable ? 1 : 0);
        if (retryable) await clock.advance(30);
        expect(failedCalls).toBe(retryable ? 2 : 1);
        expect(
          client.calls.filter((c) =>
            c.method === 'xadd' && c.args[0] === 't.dead.messaging-consumers'
          ),
        )
          .toHaveLength(1);
        expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toEqual([]);
        await broker.disconnect();
      }
    }
  });

  it('drains every subscription in parallel, so disconnect is bounded by ONE drain', async () => {
    const { clock, broker } = setup();
    await broker.connect();
    for (const topic of ['a', 'b', 'c']) {
      await broker.subscribe(topic, () => new Promise<void>(() => {}));
      await broker.publish(topic, 'm');
    }
    await clock.advance(5);
    let closed = false;
    const closing = broker.disconnect().then(() => {
      closed = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Sequential drains would need 3 × 5000 ms; parallel ones finish at 5000.
    await clock.advance(4999);
    expect(closed).toBe(false);
    await clock.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(clock.timerCount()).toBe(0);
  });

  it('bounds shutdown drain and fences late handler completion, preserving pending data', async () => {
    for (const rejects of [false, true]) {
      const { clock, client, broker, logs } = setup();
      await broker.connect();
      let finish = () => {};
      let entered = false;
      await broker.subscribe('t', () => {
        entered = true;
        return new Promise<void>((resolve, reject) => {
          finish = () => rejects ? reject(Error('late')) : resolve();
        });
      });
      await broker.publish('t', 'm1');
      await clock.advance(5);
      expect(entered).toBe(true);
      let closed = false;
      const closing = broker.disconnect().then(() => {
        closed = true;
      });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(closed).toBe(false);
      await clock.advance(4999);
      expect(closed).toBe(false);
      await clock.advance(1);
      await closing;
      expect(closed).toBe(true);
      finish();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(client.calls.filter((c) => c.method === 'xack')).toEqual([]);
      expect(client.calls.filter((c) => c.args[0] === 'DELCONSUMER')).toEqual([]);
      expect(logs.some((m) => m.includes('shutdown drain timed out'))).toBe(true);
      expect(clock.timerCount()).toBe(0);
    }
  });

  it('bounds a hung cleanup query and prevents deletion after the deadline', async () => {
    const { clock, client, broker } = setup();
    await broker.connect();
    await broker.subscribe('t', () => {});
    await clock.advance(5);
    let finish = () => {};
    let queried = false;
    client.xinfo = () =>
      new Promise<unknown[][]>((r) => {
        queried = true;
        finish = () => r([['name', 'fake-uuid-0', 'pending', 0]]);
      });
    const closing = broker.disconnect();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(queried).toBe(true);
    await clock.advance(5000);
    await closing;
    finish();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(client.calls.filter((c) => c.args[0] === 'DELCONSUMER')).toEqual([]);
    expect(clock.timerCount()).toBe(0);
  });
  it('a minimal facade without atomic call retains foreign consumers safely', async () => {
    const { clock, client, broker } = setup({ consumerIdleSweepMs: 15 });
    Object.defineProperty(client, 'call', { value: undefined });
    await broker.connect();
    await broker.subscribe('t', () => {});
    await client.xreadgroup('GROUP', 'messaging-consumers', 'foreign', 'STREAMS', 't', '>');
    await clock.advance(30);
    expect(client.calls.filter((c) => c.args[0] === 'DELCONSUMER')).toEqual([]);
    await broker.disconnect();
    expect((await client.xinfo('CONSUMERS', 't', 'messaging-consumers')).map((c) => c[1])).toEqual([
      'foreign',
    ]);
  });
  it('acknowledges a Redis 6.2 null claim of trimmed data and never acknowledges an empty lost claim', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient({
      now: clock.runtime.hrtime,
      trimmedClaimReply: 'null',
    });
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
      client,
      pollIntervalMs: 5,
      reclaimIntervalMs: 10,
      consumerRetry: { delaysMs: [20] },
    });
    await broker.connect();
    await broker.subscribe('t', () => {
      throw Error('failed');
    });
    await broker.publish('t', 'm1');
    await clock.advance(5);
    await client.xadd('t', 'MAXLEN', '~', '1', '*', 'payload', '"m2"');
    const claim = client.xclaim.bind(client);
    client.xclaim = () => Promise.resolve([]);
    await clock.advance(25);
    expect(client.calls.filter((c) => c.method === 'xack')).toHaveLength(0);
    client.xclaim = claim;
    await clock.advance(10);
    expect(client.calls.filter((c) => c.method === 'xack').map((c) => c.args[2])).toEqual(['0-0']);
    expect((await client.xpending('t', 'messaging-consumers', '-', '+', '10')).map((p) => p[0]))
      .toEqual(['0-1']);
    await broker.disconnect();
  });

  it('rotates past a high-tier batch so later eligible pending messages cannot starve', async () => {
    const { clock, client, broker } = setup({
      consumerRetry: { maxAttempts: 4, delaysMs: [20, 200] },
    });
    await broker.connect();
    const delivered: unknown[] = [];
    await broker.subscribe('t', (m) => {
      delivered.push(m);
    });
    for (let i = 0; i < 11; i++) await broker.publish('t', i);
    await client.xreadgroup(
      'GROUP',
      'messaging-consumers',
      'old',
      'COUNT',
      '11',
      'STREAMS',
      't',
      '>',
    );
    for (let i = 0; i < 10; i++) {
      await client.xclaim('t', 'messaging-consumers', 'old', '0', `0-${i}`);
    }
    await clock.advance(20);
    expect(delivered).toEqual([]);
    await clock.advance(10);
    expect(delivered).toEqual([10]);
    expect(client.calls.some((c) => c.method === 'xpending' && c.args[4] === '(0-9')).toBe(true);
    await clock.advance(180);
    expect(delivered).toHaveLength(11);
    await broker.disconnect();
  });

  it('leases one entry at a time so queued entries never age behind a slow handler', async () => {
    const { clock, client, broker } = setup();
    await broker.connect();
    const delivered: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await broker.subscribe('t', async (m) => {
      delivered.push(m);
      if (m === 0) await gate;
    });
    for (let i = 0; i < 3; i++) await broker.publish('t', i);
    // Hold the first handler past delaysMs[0]: a batched read would have
    // leased all three entries, making the queued two reclaimable elsewhere.
    await clock.advance(30);
    expect(delivered).toEqual([0]);
    const leased = await client.xpending('t', 'messaging-consumers', '-', '+', '10');
    expect(leased.map(([id]) => id)).toEqual(['0-0']);
    release();
    await clock.advance(10);
    expect(delivered).toEqual([0, 1, 2]);
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toEqual([]);
    await broker.disconnect();
  });

  it('preserves hostile header keys as own data and logs cleanup failures', async () => {
    const { clock, client, broker, logs } = setup();
    await broker.connect();
    let headers: unknown;
    await broker.subscribe('t', (_m, meta) => {
      headers = meta.headers;
    });
    await client.xadd('t', '*', 'payload', '"m1"', '__proto__', 'canary', 'constructor', 'ctor');
    await clock.advance(5);
    expect(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value).toBe('canary');
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    client.xinfo = () => Promise.reject(Error('cleanup unavailable'));
    await broker.disconnect();
    expect(logs.some((m) => m.includes('Consumer cleanup error'))).toBe(true);
    expect(clock.timerCount()).toBe(0);
  });

  it('retries through the shared metadata/header/ack path with tiered backoff', async () => {
    const { clock, client, broker } = setup();
    await broker.connect();
    const seen: unknown[] = [];
    await broker.subscribe('t', (body, meta) => {
      seen.push({ body, meta });
      if (seen.length < 3) throw Error('retry');
    });
    await broker.publishWithHeaders(
      't',
      { m: 'm1' },
      Object.fromEntries([
        ['traceparent', 'canary'],
        // An own `__proto__` key, never the prototype setter a literal key would be.
        ['__proto__', 'safe'],
      ]),
    );
    await clock.advance(5);
    expect(seen).toHaveLength(1);
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toEqual([[
      '0-0',
      'fake-uuid-0',
      0,
      1,
    ]]);
    await clock.advance(24);
    expect(seen).toHaveLength(1);
    await clock.advance(1);
    expect(seen).toHaveLength(2);
    await clock.advance(39);
    expect(seen).toHaveLength(2);
    await clock.advance(1);
    expect(seen).toHaveLength(3);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    const headers = (seen[0] as { meta: { headers?: Record<string, string> } }).meta.headers;
    expect(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value).toBe('safe');
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(client.calls.filter((c) => c.method === 'xack')).toHaveLength(1);
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it('writes original fields to the bounded group DLQ BEFORE acknowledging', async () => {
    const { clock, client, broker } = setup({ deadLetterMaxLen: 7 });
    await broker.connect();
    let calls = 0;
    await broker.subscribe('t', () => {
      calls++;
      throw Error('always');
    }, { queue: 'g' });
    await broker.publishWithHeaders('t', { m: 'm1' }, { traceparent: 'tp' });
    await clock.advance(75);
    expect(calls).toBe(3);
    const writes = client.calls.filter((c) => c.method === 'xack' || c.method === 'xadd');
    expect(writes.map((c) => c.method)).toEqual(['xadd', 'xadd', 'xack']);
    expect(writes[1].args).toEqual([
      't.dead.g',
      'MAXLEN',
      '~',
      '7',
      '*',
      'payload',
      '{"m":"m1"}',
      'traceparent',
      'tp',
      'x-setu-source-id',
      '0-0',
      'x-setu-deliveries',
      '3',
    ]);
    expect(await client.xpending('t', 'g', '-', '+', '10')).toEqual([]);
    await broker.disconnect();
  });

  it('preserves pending work on unsubscribe and disconnect; deletes self only at pending zero', async () => {
    const { clock, client, broker } = setup();
    await broker.connect();
    const subscription = await broker.subscribe('t', () => {
      throw Error('keep');
    });
    await broker.publish('t', 'pending');
    await clock.advance(5);
    await subscription.unsubscribe();
    await subscription.unsubscribe();
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toHaveLength(1);
    expect(client.calls.filter((c) => c.args[0] === 'DELCONSUMER')).toHaveLength(0);
    await broker.disconnect();
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toHaveLength(1);
    expect(clock.timerCount()).toBe(0);
  });

  it('sweeps only old, foreign, empty consumers; accepts pre-7 idle replies', async () => {
    const { clock, client, broker } = setup({ consumerIdleSweepMs: 15 });
    await broker.connect();
    await broker.subscribe('t', () => {});
    await client.xreadgroup('GROUP', 'messaging-consumers', 'foreign', 'STREAMS', 't', '>');
    // Redis 6.2 has idle but no inactive field.
    const info = client.xinfo.bind(client);
    client.xinfo = async (...args) => (await info(...args)).map((row) => row.slice(0, 6));
    await clock.advance(10);
    expect(client.calls.filter((c) => c.args[0] === 'DELCONSUMER')).toHaveLength(0);
    await clock.advance(10);
    expect(client.calls.filter((c) => c.args[0] === 'DELCONSUMER').map((c) => c.args[3])).toEqual([
      'foreign',
    ]);
    await broker.disconnect();
    expect(await client.xinfo('CONSUMERS', 't', 'messaging-consumers')).toEqual([]);
  });

  it('dead-letters malformed/missing payloads, integration rejections, and non-retryable errors immediately', async () => {
    for (const kind of ['malformed', 'missing', 'rejected', 'classified']) {
      let classified = 0;
      const { clock, client, broker } = setup({
        consumerRetry: {
          isRetryable: () => {
            classified++;
            return false;
          },
        },
      });
      await broker.connect();
      let handled = 0;
      await broker.subscribe('t', () => {
        handled++;
        if (kind === 'rejected') {
          throw new IntegrationEventRejectedError({
            reason: 'parse',
            topic: 't',
            expectedType: 'e',
            expectedVersion: 1,
            detail: 'invalid',
          });
        }
        throw Error('permanent');
      });
      await client.xadd(
        't',
        '*',
        kind === 'missing' ? 'header' : 'payload',
        kind === 'malformed' ? '{' : '"m1"',
      );
      await clock.advance(5);
      expect(handled).toBe(kind === 'missing' || kind === 'malformed' ? 0 : 1);
      expect(classified).toBe(handled);
      expect(
        client.calls.filter((c) =>
          c.method === 'xadd' && c.args[0] === 't.dead.messaging-consumers'
        ),
      ).toHaveLength(1);
      expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toEqual([]);
      await broker.disconnect();
    }
  });

  it('logs a throwing classifier and treats it as retryable', async () => {
    const { clock, client, broker, logs } = setup({
      consumerRetry: {
        delaysMs: [20],
        isRetryable: () => {
          throw Error('classifier');
        },
      },
    });
    await broker.connect();
    let handled = 0;
    await broker.subscribe('t', () => {
      if (++handled === 1) throw Error('transient');
    });
    await broker.publish('t', 'm1');
    await clock.advance(5);
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toHaveLength(1);
    await clock.advance(25);
    expect(handled).toBe(2);
    expect(logs.some((m) => m.includes('Retry classifier failed'))).toBe(true);
    await broker.disconnect();
  });

  it('preserves the PEL when dead-letter XADD fails and retries terminal work without invoking the handler', async () => {
    const { clock, client, broker, logs } = setup({
      consumerRetry: { maxAttempts: 1, delaysMs: [20] },
    });
    await broker.connect();
    let handled = 0;
    await broker.subscribe('t', () => {
      handled++;
      throw Error('always');
    });
    await broker.publish('t', 'm1');
    const add = client.xadd.bind(client);
    client.xadd = () => Promise.reject(Error('dead stream unavailable'));
    await clock.advance(35);
    expect(handled).toBe(1);
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toHaveLength(1);
    expect(client.calls.filter((c) => c.method === 'xack')).toHaveLength(0);
    expect(logs.some((m) => m.includes('Reclaim error'))).toBe(true);
    client.xadd = add;
    await clock.advance(25);
    expect(handled).toBe(1);
    expect(await client.xpending('t', 'messaging-consumers', '-', '+', '10')).toEqual([]);
    await broker.disconnect();
  });

  it('does not overlap reclaim or polling, and unsubscribe waits for active work', async () => {
    const { clock, client, broker } = setup();
    await broker.connect();
    let release = () => {};
    let handled = 0;
    const sub = await broker.subscribe('t', () => {
      handled++;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    await broker.publish('t', 'm1');
    await broker.publish('t', 'm2');
    await clock.advance(5);
    expect(handled).toBe(1); // prove the handler is in flight BEFORE moving time
    await clock.advance(40);
    expect(handled).toBe(1);
    expect(client.calls.filter((c) => c.method === 'xclaim')).toHaveLength(0);
    expect(client.calls.filter((c) => c.method === 'xreadgroup')).toHaveLength(1);
    let closed = false;
    const closing = sub.unsubscribe().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect(clock.timerCount()).toBe(0);
    await broker.disconnect();
  });

  it('models atomic claims and trimmed entries faithfully', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient({ now: clock.runtime.hrtime });
    await client.xgroup('CREATE', 't', 'g', '0', 'MKSTREAM');
    const id = await client.xadd('t', '*', 'payload', '"m1"');
    await client.xreadgroup('GROUP', 'g', 'old', 'STREAMS', 't', '>');
    expect(await client.xclaim('t', 'g', 'a', '20', id)).toEqual([]);
    await clock.advance(20);
    const claims = await Promise.all([
      client.xclaim('t', 'g', 'a', '20', id),
      client.xclaim('t', 'g', 'b', '20', id),
    ]);
    expect(claims.map((c) => c.length)).toEqual([1, 0]);
    expect(await client.xpending('t', 'g', '-', '+', '10')).toEqual([[id, 'a', 0, 2]]);
    await client.xadd('t', 'MAXLEN', '~', '1', '*', 'payload', '"m2"');
    expect(await client.xclaim('t', 'g', 'a', '0', id)).toEqual([]);
    expect(await client.xpending('t', 'g', '-', '+', '10')).toEqual([]);
    await client.xreadgroup('GROUP', 'g', 'old', 'STREAMS', 't', '>');
    expect(await client.xgroup('DELCONSUMER', 't', 'g', 'old')).toBe(1);
    expect(await client.xpending('t', 'g', '-', '+', '10')).toEqual([]);
  });

  it('refuses invalid option bounds at construction and requires all facade methods', () => {
    const clock = clockRuntime();
    const construct = (options: RedisStreamsOptions) =>
      new RedisStreamsBroker(clock.runtime, new JsonSerializer(), options);
    for (
      const bad of [
        NaN,
        Infinity,
        -Infinity,
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        '5' as unknown as number,
      ]
    ) {
      for (
        const name of ['reclaimIntervalMs', 'deadLetterMaxLen', 'consumerIdleSweepMs'] as const
      ) expect(() => construct({ [name]: bad })).toThrow(RangeError);
      expect(() => construct({ consumerRetry: { maxAttempts: bad } })).toThrow(RangeError);
      expect(() => construct({ consumerRetry: { delaysMs: [bad] } })).toThrow(RangeError);
    }
    for (const name of ['reclaimIntervalMs', 'consumerIdleSweepMs'] as const) {
      expect(() => construct({ [name]: 2147483648 })).toThrow(RangeError);
    }
    for (const delaysMs of [[], [20, 10], [2147483648]]) {
      expect(() => construct({ consumerRetry: { delaysMs } })).toThrow(RangeError);
    }
    const client = new FakeRedisStreamsClient();
    for (const name of ['xpending', 'xclaim', 'xinfo'] as const) {
      const facade = Object.create(client) as Record<string, unknown>;
      facade[name] = undefined;
      expect(validateClient(facade)).toBe(false);
    }
  });
});
