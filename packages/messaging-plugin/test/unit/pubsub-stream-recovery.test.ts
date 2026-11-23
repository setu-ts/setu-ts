import { describe, expect, it, vi } from 'vitest';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud, pubSubTransport } from '../fixtures/cloud-transports.ts';

describe('Pub/Sub streaming-pull recovery', () => {
  it('cancels recovery when a stream closes before its initial open resolves', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const close = vi.fn(() => Promise.resolve());
    vi.mocked(h.transport.open).mockImplementationOnce((_topic, _name, _deliver, options) => {
      options?.onClosed?.({ code: 5 });
      return Promise.resolve({ close, created: true });
    });
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      consumerRetry: false,
    });
    await broker.connect();
    await expect(broker.subscribe('orders', () => {})).rejects.toThrow('closed while opening');
    expect(close).toHaveBeenCalledOnce();
    expect(clock.timerCount()).toBe(0);
    await clock.advance(10000);
    expect(h.transport.open).toHaveBeenCalledOnce();
    await broker.disconnect();
  });
  it('reopens after 1, 2, 5, 10, then 30 seconds, keeping reachability down until recovery', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const warn = vi.fn();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      consumerRetry: false,
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    h.opens[0]!.options?.onClosed?.({ code: 5, message: 'secret-remote' });
    h.opens[0]!.options?.onClosed?.({ code: 5 });
    expect(await broker.reachability()).toBe(false);
    const open = vi.mocked(h.transport.open);
    open.mockRejectedValue(new Error('secret-remote'));
    for (const delay of [1000, 2000, 5000, 10000, 30000, 30000]) {
      const calls = open.mock.calls.length;
      await clock.advance(delay - 1);
      expect(open).toHaveBeenCalledTimes(calls);
      await clock.advance(1);
      expect(open).toHaveBeenCalledTimes(calls + 1);
    }
    expect(h.opens[0]!.close).toHaveBeenCalledOnce();
    open.mockImplementation((topic, name, deliver, options) => {
      const close = vi.fn(() => Promise.resolve());
      h.opens.push({ topic, name, deliver, ...(options === undefined ? {} : { options }), close });
      return Promise.resolve({ close, created: true });
    });
    await clock.advance(30000);
    expect(await broker.reachability()).toBe(true);
    expect(warn.mock.calls).toEqual([
      ['Pub/Sub subscription stream closed; re-opening'],
      ['Pub/Sub subscription stream recovered'],
    ]);
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it.each(['unsubscribe', 'disconnect'])(
    'cancels queued recovery on %s and ignores late deliveries',
    async (kind) => {
      const h = pubSubTransport();
      const clock = clockRuntime();
      const handler = vi.fn();
      const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
        consumerRetry: false,
      });
      await broker.connect();
      const sub = await broker.subscribe('orders', handler);
      h.opens[0]!.options?.onClosed?.(undefined);
      await (kind === 'unsubscribe' ? sub.unsubscribe() : broker.disconnect());
      await sub.unsubscribe();
      await clock.advance(100000);
      h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      await flushCloud();
      expect(handler).not.toHaveBeenCalled();
      expect(h.transport.open).toHaveBeenCalledOnce();
      expect(clock.timerCount()).toBe(0);
      await broker.disconnect();
    },
  );

  it('closes a late recovery handle and retains original fan-out creation policy', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      deadLetterTopic: 'dead',
    });
    await broker.connect();
    const sub = await broker.subscribe('orders', () => {}, { fanOut: true });
    const original = h.opens[0]!.options?.create;
    h.opens[0]!.options?.onClosed?.(undefined);
    const pending = Promise.withResolvers<{ close(): Promise<void>; created: boolean }>();
    vi.mocked(h.transport.open).mockReturnValueOnce(pending.promise);
    await clock.advance(1000);
    expect(vi.mocked(h.transport.open).mock.calls[1]![3]?.create).toEqual(original);
    await sub.unsubscribe();
    const close = vi.fn(() => Promise.resolve());
    pending.resolve({ close, created: true });
    await flushCloud();
    expect(close).toHaveBeenCalledOnce();
    expect(await broker.reachability()).toBe(true);
    expect(clock.timerCount()).toBe(0);
    await broker.disconnect();
  });

  it('recreation checks missing targets without logging remote text or repeated warnings', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const warn = vi.fn();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      deadLetterTopic: 'dead',
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    h.opens[0]!.options?.onClosed?.(undefined);
    vi.mocked(h.transport.open).mockRejectedValue({ code: 13, message: 'secret' });
    vi.mocked(h.transport.topicExists!).mockResolvedValue(false);
    await clock.advance(1000);
    await clock.advance(2000);
    expect(h.transport.topicExists).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
});
