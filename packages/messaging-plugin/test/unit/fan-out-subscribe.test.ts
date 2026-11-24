import { describe, expect, it, vi } from 'vitest';
import { FAN_OUT_ARMS, fanOutPair } from '../fixtures/fan-out-backends.ts';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { InMemoryBroker } from '../../src/brokers/in-memory-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { onIntegrationEvent } from '../../src/integration/subscribe.ts';
import { defineIntegrationEvent } from '../../src/integration/definition.ts';
import { fanOutName } from '../../src/brokers/fan-out.ts';
import { TracedBroker } from '../../src/tracing/traced-broker.ts';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import { recordingTelemetry } from '../fixtures/outbox.ts';
import { NatsBroker } from '../../src/brokers/nats-broker.ts';
import {
  FakeNatsConnection,
  FakeNatsConsumer,
  FakeNatsMessage,
} from '../fixtures/fake-nats-client.ts';

describe('fan-out subscription contract', () => {
  it.each(['traced', 'pipelined'] as const)(
    'preserves the subscription marker through the %s facade',
    async (kind) => {
      const clock = clockRuntime();
      const inner = new InMemoryBroker(clock.runtime, new JsonSerializer());
      const broker =
        kind === 'traced'
          ? new TracedBroker(inner, recordingTelemetry(), 'memory')
          : new PipelinedBroker(inner, []);
      await broker.connect();
      const handler = vi.fn();
      const sub = await broker.subscribe('frames', handler, { fanOut: true });
      expect(sub.fanOut).toBe(true);
      await broker.publish('frames', 1);
      for (let n = 0; n < 50; n++) await Promise.resolve();
      expect(handler).toHaveBeenCalledOnce();
      await sub.unsubscribe();
      await broker.disconnect();
    },
  );
  it('retires a NATS consume handle arriving after disconnect and dispatches no stale callback', async () => {
    const clock = clockRuntime();
    const client = new FakeNatsConnection();
    const consumer = new FakeNatsConsumer([]);
    vi.spyOn(client.jetstream().consumers, 'get').mockResolvedValue(consumer);
    const pending = Promise.withResolvers<Awaited<ReturnType<FakeNatsConsumer['consume']>>>();
    const consume = vi.spyOn(consumer, 'consume').mockReturnValue(pending.promise);
    const broker = new NatsBroker(clock.runtime, new JsonSerializer(), { client });
    const handler = vi.fn();
    await broker.connect();
    const subscribing = broker.subscribe('frames', handler, { fanOut: true });
    for (let n = 0; n < 50; n++) await Promise.resolve();
    expect(consume).toHaveBeenCalledOnce();
    await broker.disconnect();
    consume.mock.calls[0]![0].callback(new FakeNatsMessage('{}', 1, 0, 'frames'));
    const stop = vi.fn();
    pending.resolve({
      stop,
      status: () =>
        Promise.resolve({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true as const, value: undefined }),
          }),
        }),
    });
    await expect(subscribing).rejects.toThrow('disconnected while subscribing');
    expect(stop).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(clock.timerCount()).toBe(0);
  });
  it.each(FAN_OUT_ARMS)('%s refuses fanOut with a competing queue', async (arm) => {
    const h = await fanOutPair(arm);
    try {
      await expect(
        h.brokers[0].subscribe('frames', () => {}, { fanOut: true, queue: 'workers' }),
      ).rejects.toThrow(RangeError);
    } finally {
      await h.close();
    }
  });
  it('respond ignores fanOut once and retains its competing queue', async () => {
    const clock = clockRuntime();
    const warn = vi.fn();
    const broker = new InMemoryBroker(clock.runtime, new JsonSerializer(), { warn });
    await broker.connect();
    const subscribe = vi.spyOn(broker, 'subscribe');
    await broker.respond('rpc', () => 1, { queue: 'workers', fanOut: true });
    await broker.respond('rpc', () => 1, { fanOut: true });
    expect(subscribe.mock.calls[0]![2]).toEqual({ queue: 'workers' });
    expect(subscribe.mock.calls[1]![2]).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Messaging respond ignores fanOut; responders get the broker's queue-less delivery (pass queue to make responders compete)",
    );
    await broker.disconnect();
    const throwing = new InMemoryBroker(clock.runtime, new JsonSerializer(), {
      warn: () => {
        throw 1;
      },
    });
    await throwing.respond('rpc', () => 1, { fanOut: true });
    await throwing.disconnect();
  });
  it('refuses a per-replica fanOut subscription with a durable inbox', () => {
    const event = defineIntegrationEvent({
      type: 'orders',
      topic: 'orders.v1',
      version: 1,
      parse: (data: unknown) => data,
    });
    expect(() =>
      onIntegrationEvent(event, () => {}, { fanOut: true, inbox: { consumer: 'worker' } }),
    ).toThrow(RangeError);
  });
  it('keeps the Service Bus owner visible within fifty characters', () => {
    const id = '01234567-89ab-4cde-8f01-23456789abcd';
    expect(fanOutName('--' + 'a'.repeat(40), id, true)).toBe(
      'a'.repeat(28) + '-fanout-0123456789ab',
    );
    expect(fanOutName('---...___', id, true)).toBe('messaging-fanout-0123456789ab');
    expect(fanOutName('owner', id)).toBe('owner-fanout-' + id);
  });
});

describe('Redis Streams independent reader', () => {
  it('refuses new readers during disconnect and never revives them on reconnect', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), { client });
    await broker.connect();
    const shutdown = broker.disconnect();
    await expect(broker.subscribe('frames', () => {}, { fanOut: true })).rejects.toThrow(
      'disconnected while subscribing',
    );
    await shutdown;
    await broker.connect();
    await clock.advance(500);
    expect(client.calls.filter((call) => call.method === 'xread')).toEqual([]);
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
  it('stops between batch entries when unsubscribe lands during a handler', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), { client });
    const held = Promise.withResolvers<void>();
    const handler = vi.fn(() => held.promise);
    await broker.connect();
    const sub = await broker.subscribe('frames', handler, { fanOut: true });
    await client.xadd('frames', '1-0', 'payload', '1');
    await client.xadd('frames', '2-0', 'payload', '2');
    await clock.advance(100);
    expect(handler).toHaveBeenCalledOnce();
    const closing = sub.unsubscribe();
    held.resolve();
    await closing;
    expect(handler).toHaveBeenCalledOnce();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
  it('absorbs a read rejection arriving while unsubscribe drains without logging after close', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    const error = vi.fn();
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
      client,
      logger: { error },
    });
    const read = Promise.withResolvers<unknown[][] | null>();
    vi.spyOn(client, 'xread').mockReturnValueOnce(read.promise);
    await broker.connect();
    const sub = await broker.subscribe('frames', () => {}, { fanOut: true });
    await clock.advance(100);
    const closing = sub.unsubscribe();
    read.reject(new Error('remote-secret'));
    await closing;
    expect(error).not.toHaveBeenCalled();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
  it('captures the last ID at subscribe, retains it through empty and failed reads, and never creates a group or reclaims', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    await client.xadd('frames', '10-0', 'payload', '0');
    const error = vi.fn();
    const handler = vi.fn();
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
      client,
      logger: { error },
      reclaimIntervalMs: 100,
    });
    await broker.connect();
    const sub = await broker.subscribe('frames', handler, { fanOut: true });
    expect(client.calls.find((call) => call.method === 'xrevrange')?.args).toEqual([
      'frames',
      '+',
      '-',
      'COUNT',
      '1',
    ]);
    await client.xadd('frames', '11-0', 'payload', '1');
    await clock.advance(100);
    expect(handler).toHaveBeenCalledWith(1, { topic: 'frames', messageId: '11-0', headers: {} });
    await clock.advance(100);
    vi.spyOn(client, 'xread').mockRejectedValueOnce(new Error('remote-secret'));
    await clock.advance(100);
    await client.xadd(
      'frames',
      '12-0',
      'payload',
      '2',
      'header',
      'value',
      '__proto__',
      'prototype-header',
    );
    await clock.advance(100);
    const reads = client.calls.filter((call) => call.method === 'xread');
    expect(reads.map((call) => call.args.at(-1))).toEqual(['10-0', '11-0', '11-0']);
    expect(reads[0]!.args).toEqual(['COUNT', '100', 'BLOCK', '100', 'STREAMS', 'frames', '10-0']);
    expect(
      client.calls.some((call) => ['xgroup', 'xpending', 'xclaim'].includes(call.method)),
    ).toBe(false);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(Object.hasOwn(handler.mock.calls[1]![1].headers!, '__proto__')).toBe(true);
    expect(handler.mock.calls[1]![1].headers?.['__proto__']).toBe('prototype-header');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Redis fanOut read failed (unknown error); retaining last stream ID',
    );
    await sub.unsubscribe();
    await clock.advance(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
  it('starts an empty stream at 0-0 and logs failed or unreadable frames once without retry', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    const error = vi.fn();
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
      client,
      logger: { error },
    });
    await broker.connect();
    const handler = vi.fn(() => {
      throw new Error('payload-canary');
    });
    await broker.subscribe('frames', handler, { fanOut: true });
    await client.xadd('frames', '1-0', 'payload', '{}');
    await client.xadd('frames', '2-0', 'other', 'secret');
    await client.xadd('frames', '3-0', 'payload', 'invalid');
    await clock.advance(500);
    expect(client.calls.find((call) => call.method === 'xread')!.args.at(-1)).toBe('0-0');
    expect(handler).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(error.mock.calls)).not.toContain('payload-canary');
    await broker.disconnect();
  });
  it.each(['xread', 'xrevrange'] as const)(
    'requires %s only when independent delivery is requested',
    async (method) => {
      const clock = clockRuntime();
      const client = new FakeRedisStreamsClient();
      Object.defineProperty(client, method, { value: undefined });
      const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), { client });
      await broker.connect();
      await expect(broker.subscribe('frames', () => {}, { fanOut: true })).rejects.toThrow(method);
      await broker.subscribe('ordinary', () => {});
      await broker.disconnect();
    },
  );
  it('drains a pending read, drops its late delivery, and bounds a read that never settles', async () => {
    for (const never of [false, true]) {
      const clock = clockRuntime();
      const client = new FakeRedisStreamsClient();
      const error = vi.fn();
      const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
        client,
        logger: { error },
      });
      await broker.connect();
      const handler = vi.fn();
      const sub = await broker.subscribe('frames', handler, { fanOut: true });
      const read = Promise.withResolvers<unknown[][] | null>();
      vi.spyOn(client, 'xread').mockReturnValueOnce(read.promise);
      await clock.advance(200);
      const closing = sub.unsubscribe();
      if (never) await clock.advance(5000);
      else read.resolve([['frames', [['1-0', ['payload', '{}']]]]]);
      await closing;
      expect(handler).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(never ? 1 : 0);
      await broker.disconnect();
      expect(clock.timerCount()).toBe(0);
    }
  });
  it('refuses a subscription whose captured start arrives after disconnect', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    const range = Promise.withResolvers<Array<[string, string[]]>>();
    vi.spyOn(client, 'xrevrange').mockReturnValueOnce(range.promise);
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), { client });
    await broker.connect();
    const subscription = broker.subscribe('frames', () => {}, { fanOut: true });
    await broker.disconnect();
    range.resolve([]);
    await expect(subscription).rejects.toThrow('disconnected while subscribing');
  });
  it('logs a persistent read failure once with its Redis code, and survives a throwing logger', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient();
    const error = vi.fn(() => {
      throw new Error('sink down');
    });
    const broker = new RedisStreamsBroker(clock.runtime, new JsonSerializer(), {
      client,
      logger: { error },
      reclaimIntervalMs: 100,
    });
    await broker.connect();
    const handler = vi.fn(() => {
      throw new Error('handler failed');
    });
    const sub = await broker.subscribe('frames', handler, { fanOut: true });
    const read = vi
      .spyOn(client, 'xread')
      .mockRejectedValue(new Error('NOPERM this user has no permissions to run the xread command'));
    for (let n = 0; n < 5; n++) await clock.advance(100);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Redis fanOut read failed (NOPERM); retaining last stream ID',
    );
    read.mockRestore();
    await clock.advance(100);
    vi.spyOn(client, 'xread').mockRejectedValueOnce(new Error('NOPERM again'));
    await clock.advance(100);
    expect(error).toHaveBeenCalledTimes(2);
    await client.xadd('frames', '20-0', 'payload', '1');
    await clock.advance(100);
    expect(handler).toHaveBeenCalledOnce();
    await sub.unsubscribe();
    await broker.disconnect();
  });
});
