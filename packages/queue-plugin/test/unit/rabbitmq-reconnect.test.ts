import { EventEmitter } from 'node:events';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { IAmqpQueueConnection } from '../../src/interfaces/index.ts';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { StaleClaimError } from '../../src/errors.ts';
import { FakeAmqpQueueChannel } from '../fixtures/fake-amqplib-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

const factory = vi.hoisted(() => ({ connect: vi.fn<() => Promise<IAmqpQueueConnection>>() }));
vi.mock('amqplib', () => ({ connect: factory.connect }));

class Connection extends EventEmitter {
  channels: FakeAmqpQueueChannel[] = [];
  closes = 0;
  fail = false;
  pending: Promise<FakeAmqpQueueChannel> | undefined;
  createChannel(): Promise<FakeAmqpQueueChannel> {
    if (this.fail) return Promise.reject(new Error('not ready'));
    const channel = new FakeAmqpQueueChannel();
    this.channels.push(channel);
    return this.pending ?? Promise.resolve(channel);
  }
  close(): Promise<void> {
    this.closes++;
    return Promise.resolve();
  }
}

const job = { id: 'old', name: 'email', data: {}, attempts: 1, maxAttempts: 3, availableAtMs: 0 };

describe('RabbitMQ queue reconnect', () => {
  for (const settlement of ['ack', 'requeue', 'deadLetter'] as const) {
    it(`rejects a late ${settlement} without settling the redelivered message`, async () => {
      const runtime = new FakeRuntimeServices(0);
      const connection = new Connection();
      const queue = new RabbitMqQueue(runtime, { client: connection });
      await queue.connect();
      try {
        await queue.enqueue(job);
        const [before] = await queue.reserve('email', 1, 0);
        connection.emit('close');
        await runtime.advanceMs(1000);
        // The fake has no broker; reproduce its redelivery of identical bytes.
        await queue.enqueue(job);
        const [after] = await queue.reserve('email', 1, 0);
        expect(after.id).toBe(before.id);
        expect(after.claimToken).not.toBe(before.claimToken);
        const settle = (token: string | undefined) =>
          settlement === 'ack'
            ? queue.ack('email', job.id, token)
            : settlement === 'requeue'
              ? queue.requeue('email', job.id, 1000, 2, token)
              : queue.deadLetter('email', job.id, 0, token);
        const lateError: unknown = await settle(before.claimToken).then(
          () => undefined,
          (error: unknown) => error,
        );
        const channel = connection.channels.at(-1)!;
        expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(0);
        expect(lateError).toBeInstanceOf(StaleClaimError);
        expect(channel.calls.filter((call) => call.method === 'publish')).toHaveLength(1);
        await settle(after.claimToken);
        expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(1);
      } finally {
        await queue.disconnect();
      }
    });
  }
  it('closes an owned connection that finishes opening after disconnect', async () => {
    const runtime = new FakeRuntimeServices(0);
    const initial = new Connection();
    const opening = Promise.withResolvers<IAmqpQueueConnection>();
    factory.connect.mockResolvedValueOnce(initial).mockImplementationOnce(() => opening.promise);
    const queue = new RabbitMqQueue(runtime);
    await queue.connect();
    initial.emit('close');
    await runtime.advanceMs(1000);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(factory.connect).toHaveBeenCalledTimes(2);
    // Each attempt carries amqplib's socket timeout, so a broker that accepts
    // TCP and never answers fails the attempt instead of hanging it (audit L1).
    for (const call of factory.connect.mock.calls as unknown[][])
      expect(call[1]).toEqual({ timeout: 10_000 });
    await queue.disconnect();
    const late = new Connection();
    opening.resolve(late);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(late.closes).toBe(1);
    expect(late.channels).toHaveLength(0);
    expect(late.listenerCount('error')).toBe(0);
  });

  it('reopens only an injected connection channel, clears claims and assertions, and disposes listeners over 20 flaps', async () => {
    const runtime = new FakeRuntimeServices(0);
    const connection = new Connection();
    const queue = new RabbitMqQueue(runtime, { client: connection });
    await queue.connect();
    await queue.enqueue(job);
    expect(await queue.reserve('email', 1, 0)).toHaveLength(1);
    let processing = connection.channels[0];
    for (let i = 0; i < 20; i++) {
      const old = processing;
      connection.emit('error', new Error('fault'));
      connection.emit('close');
      expect(await queue.isHealthy!()).toBe(false);
      await runtime.advanceMs(1000);
      expect(await queue.isHealthy!()).toBe(true);
      processing = connection.channels.at(-2)!;
      expect(old.listenerCount('error')).toBe(0);
      expect(connection.listenerCount('error')).toBe(1);
      expect(connection.listenerCount('close')).toBe(1);
    }
    // One initial processing channel, then a reopened processing channel and
    // one throwaway health channel per flap. Every health channel is released.
    expect(connection.channels).toHaveLength(41);
    for (let index = 2; index < connection.channels.length; index += 2) {
      expect(
        connection.channels[index].calls.filter((call) => call.method === 'close'),
      ).toHaveLength(1);
    }
    expect(connection.closes).toBe(0);
    await expect(queue.ack('email', 'old')).rejects.toThrow('claim is stale');
    await expect(queue.requeue('email', 'old', 0, 2)).rejects.toThrow('claim is stale');
    await expect(queue.deadLetter('email', 'old', 0)).rejects.toThrow('claim is stale');
    const channel = processing;
    expect(channel.calls.filter((call) => call.method === 'ack')).toEqual([]);
    await queue.enqueue({ ...job, id: 'new' });
    expect(channel.calls.filter((call) => call.method === 'assertQueue')).toHaveLength(3);
    const [reserved] = await queue.reserve('email', 1, 0);
    expect(reserved.id).toBe('new');
    await queue.ack('email', 'new', reserved.claimToken);
    await queue.disconnect();
    expect(connection.listenerCount('error')).toBe(0);
    expect(channel.listenerCount('error')).toBe(0);
    await runtime.advanceMs(60_000);
    expect(connection.channels).toHaveLength(41);
  });

  it('retries failed channel creation and cancels pending retries on disconnect', async () => {
    // Full-jitter backoff draws from Math.random. Small early draws let three
    // attempts fail before 1000 ms, and the fourth may then wait up to 4000 ms,
    // past the 2000 ms recovery window. Pinning 0.5 gives 250, 500 and 1000 ms.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onTestFinished(() => random.mockRestore());
    const runtime = new FakeRuntimeServices(0);
    const connection = new Connection();
    const queue = new RabbitMqQueue(runtime, { client: connection });
    await queue.connect();
    connection.fail = true;
    connection.channels[0].emitClose();
    await runtime.advanceMs(1000);
    expect(await queue.isHealthy!()).toBe(false);
    connection.fail = false;
    await runtime.advanceMs(2000);
    expect(await queue.isHealthy!()).toBe(true);
    connection.emit('close');
    await queue.disconnect();
    const count = connection.channels.length;
    await runtime.advanceMs(60_000);
    expect(connection.channels).toHaveLength(count);
    await queue.connect();
    connection.emit('close');
    await runtime.advanceMs(1000);
    expect(await queue.isHealthy!()).toBe(true);
    await queue.disconnect();
  });

  it('moves bodies that are not stored jobs to the dead queue and keeps the batch (audit L4)', async () => {
    const runtime = new FakeRuntimeServices(0);
    const connection = new Connection();
    const warnings: string[] = [];
    const queue = new RabbitMqQueue(runtime, {
      client: connection,
      reportWarning: (message) => warnings.push(message),
    });
    await queue.connect();
    try {
      const channel = connection.channels[0];
      const bad = [
        '"string"',
        'not json',
        '[1]',
        '{"id":7}',
        '{"id":"x"}',
        '{"id":"x","name":"email","data":1,"attempts":"1","maxAttempts":3,"availableAtMs":0}',
      ];
      channel.publish('', 'he.queue.email.ready', Buffer.from(bad[0]));
      await queue.enqueue(job);
      for (const body of bad.slice(1))
        channel.publish('', 'he.queue.email.ready', Buffer.from(body));
      const reserved = await queue.reserve('email', 10, 0);
      expect(reserved.map((entry) => entry.id)).toEqual(['old']);
      expect(
        channel.getReadyBuffer('he.queue.email.dead').map((entry) => entry.content.toString()),
      ).toEqual(bad);
      expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(bad.length);
      const moved = warnings.filter((warning) => warning.includes('moved to the dead queue'));
      expect(moved).toHaveLength(bad.length);
      for (const warning of warnings) for (const body of bad) expect(warning).not.toContain(body);
      await queue.ack('email', 'old', reserved[0].claimToken);
    } finally {
      await queue.disconnect();
    }
  });

  it('stops fetching and returns what it claimed when the dead queue refuses a move (audit N1)', async () => {
    const runtime = new FakeRuntimeServices(0);
    const connection = new Connection();
    const warnings: string[] = [];
    const queue = new RabbitMqQueue(runtime, {
      client: connection,
      reportWarning: (message) => warnings.push(message),
    });
    await queue.connect();
    try {
      const channel = connection.channels[0];
      await queue.enqueue(job);
      channel.publish('', 'he.queue.email.ready', Buffer.from('"string"'));
      await queue.enqueue({ ...job, id: 'later' });
      const publish = channel.publish.bind(channel);
      vi.spyOn(channel, 'publish').mockImplementation((exchange, key, content, options, cb) => {
        if (key.endsWith('.dead')) throw new Error('dead queue refused');
        return publish(exchange, key, content, options, cb);
      });
      const reserved = await queue.reserve('email', 10, 0);
      expect(reserved.map((entry) => entry.id)).toEqual(['old']);
      expect(warnings.filter((w) => w.includes('could not be moved'))).toHaveLength(1);
      expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(0);
      await queue.ack('email', 'old', reserved[0].claimToken);
      expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(1);
    } finally {
      await queue.disconnect();
    }
  });

  it('bounds a whole lazy connection attempt and closes a connection that opens late (audit N2)', async () => {
    const runtime = new FakeRuntimeServices(0);
    const opening = Promise.withResolvers<IAmqpQueueConnection>();
    factory.connect.mockReset();
    factory.connect.mockImplementationOnce(() => opening.promise);
    const queue = new RabbitMqQueue(runtime);
    const connecting = queue.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    // The deadline arms only once amqplib has loaded and connect() was called.
    while (factory.connect.mock.calls.length === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.advanceMs(9_999);
    let settled = false;
    void connecting.then(() => (settled = true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    await runtime.advanceMs(1);
    expect(await connecting).toEqual(
      new Error('RabbitMQ did not complete the connection within 10000 ms'),
    );
    const late = new Connection();
    opening.resolve(late);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(late.closes).toBe(1);
    expect(late.channels).toHaveLength(0);
  });

  it('closes a channel that finishes opening after disconnect', async () => {
    const runtime = new FakeRuntimeServices(0);
    const connection = new Connection();
    const queue = new RabbitMqQueue(runtime, { client: connection });
    await queue.connect();
    const opening = Promise.withResolvers<FakeAmqpQueueChannel>();
    connection.pending = opening.promise;
    connection.emit('close');
    await runtime.advanceMs(1000);
    await queue.disconnect();
    const late = new FakeAmqpQueueChannel();
    opening.resolve(late);
    await runtime.advanceMs(100);
    expect(late.calls.map((call) => call.method)).toContain('close');
    expect(connection.listenerCount('error')).toBe(0);
  });
});
