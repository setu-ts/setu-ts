import { describe, expect, it, vi } from 'vitest';
import { NatsBroker } from '../../src/brokers/nats-broker.ts';
import { REPLY_INBOX_TRANSIENT } from '../../src/brokers/inbox.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { FakeNatsConnection } from '../fixtures/fake-nats-client.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

async function setup(transient = true, logger = { error: vi.fn() }) {
  const client = new FakeNatsConnection();
  const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), { client, logger });
  await broker.connect();
  const jsm = await client.jetstreamManager();
  const js = client.jetstream();
  const sub = await broker.subscribe('rr.inbox.x', () => {}, {
    queue: 'rr.inbox.x',
    ...(transient ? { [REPLY_INBOX_TRANSIENT]: true } : {}),
  });
  return { broker, jsm, js, sub, logger };
}

describe('NATS ephemeral reply inbox', () => {
  it('uses the marker to create an ephemeral inbox and deletes it on close', async () => {
    const { broker, jsm, js, sub } = await setup();
    expect(jsm.calls.find((c) => c.method === 'consumers.add')!.args[1]).toEqual({
      name: 'rr_2einbox_2ex',
      filter_subject: 'rr.inbox.x',
      ack_policy: 'explicit',
      deliver_policy: 'new',
      inactive_threshold: 300_000_000_000,
    });
    await sub.unsubscribe();
    await sub.unsubscribe();
    expect(js.handedOutConsumers[0]!.isStopped()).toBe(true);
    expect(jsm.calls.filter((c) => c.method === 'consumers.delete').map((c) => c.args)).toEqual([
      ['MESSAGING', 'rr_2einbox_2ex'],
    ]);
    await broker.disconnect();
  });

  it('keeps an unmarked public inbox-shaped queue durable', async () => {
    const { broker, jsm } = await setup(false);
    expect(jsm.calls.find((c) => c.method === 'consumers.add')!.args[1]).toEqual({
      name: 'rr_2einbox_2ex',
      durable_name: 'rr_2einbox_2ex',
      filter_subject: 'rr.inbox.x',
      ack_policy: 'explicit',
      metadata: { 'setu.queue': 'rr.inbox.x' },
    });
    await broker.disconnect();
    expect(jsm.calls.filter((c) => c.method === 'consumers.delete')).toEqual([]);
  });

  it.each(['reject', 'hang', 'logger throws'] as const)(
    'bounds and logs a delete failure (%s)',
    async (mode) => {
      vi.useFakeTimers();
      const logger = {
        error: vi.fn((message: string) => {
          void message;
          if (mode === 'logger throws') throw new Error('logger');
        }),
      };
      const { broker, jsm } = await setup(true, logger);
      vi.spyOn(jsm.consumers, 'delete').mockImplementation(() =>
        mode === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('delete refused')),
      );
      try {
        const close = broker.disconnect();
        await vi.advanceTimersByTimeAsync(2000);
        await close;
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls[0]![0]).toContain('inbox delete');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['consumer_deleted', 'consumer_not_found'])(
    'replaces the running handle after %s and closes the replacement',
    async (type) => {
      const { broker, js, jsm, sub } = await setup();
      const first = js.handedOutConsumers[0]!;
      first.emitStatus('heartbeat');
      await vi.waitFor(() => expect(js.handedOutConsumers).toHaveLength(1));
      first.emitStatus(type);
      await vi.waitFor(() => expect(js.handedOutConsumers).toHaveLength(2));
      expect(first.isStopped()).toBe(true);
      expect(jsm.calls.filter((c) => c.method === 'consumers.add')).toHaveLength(2);
      await sub.unsubscribe();
      expect(js.handedOutConsumers[1]!.isStopped()).toBe(true);
      js.handedOutConsumers[1]!.emitStatus(type);
      await broker.disconnect();
      expect(js.handedOutConsumers).toHaveLength(2);
    },
  );

  it.each([false, true])(
    'retries a failed recreate after waitMs; close cancels it=%s',
    async (close) => {
      vi.useFakeTimers();
      const { broker, js, jsm, sub, logger } = await setup();
      const add = vi.spyOn(jsm.consumers, 'add').mockRejectedValueOnce(new Error('offline'));
      try {
        js.handedOutConsumers[0]!.emitStatus('consumer_deleted');
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(add).toHaveBeenCalledTimes(1);
        if (close) await sub.unsubscribe();
        await vi.advanceTimersByTimeAsync(1999);
        expect(add).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(add).toHaveBeenCalledTimes(close ? 1 : 2);
        expect(js.handedOutConsumers).toHaveLength(close ? 1 : 2);
      } finally {
        await broker.disconnect();
        vi.useRealTimers();
      }
    },
  );

  it('stops a recreation that finishes after close and deletes the late consumer', async () => {
    const { broker, js, jsm, sub } = await setup();
    const pending = Promise.withResolvers<{ name: string }>();
    vi.spyOn(jsm.consumers, 'add').mockReturnValueOnce(pending.promise);
    js.handedOutConsumers[0]!.emitStatus('consumer_deleted');
    await vi.waitFor(() => expect(jsm.consumers.add).toHaveBeenCalledTimes(1));
    await sub.unsubscribe();
    pending.resolve({ name: 'rr_2einbox_2ex' });
    await vi.waitFor(() => expect(js.handedOutConsumers).toHaveLength(2));
    expect(js.handedOutConsumers[1]!.isStopped()).toBe(true);
    expect(jsm.calls.filter((c) => c.method === 'consumers.delete')).toHaveLength(2);
    await broker.disconnect();
  });
});
