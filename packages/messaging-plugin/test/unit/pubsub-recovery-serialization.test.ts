import { describe, expect, it, vi } from 'vitest';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud, pubSubTransport } from '../fixtures/cloud-transports.ts';

describe('Pub/Sub recovery serialization', () => {
  it('waits for a failed replacement to close before starting the next recovery', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
    });
    const held = Promise.withResolvers<void>();
    await broker.connect();
    const sub = await broker.subscribe('frames', () => {}, { fanOut: true });
    h.response.created = false;
    const close = vi.fn(() => held.promise);
    vi.mocked(h.transport.open).mockImplementationOnce((_topic, _queue, _deliver, options) => {
      options!.onClosed!(undefined);
      return Promise.resolve({ close, created: true });
    });
    h.opens[0]!.options!.onClosed!(undefined);
    await clock.advance(1000);
    expect(close).toHaveBeenCalledOnce();
    await clock.advance(30000);
    const callsWhileClosing = vi.mocked(h.transport.open).mock.calls.length;
    held.resolve();
    await flushCloud();
    expect(callsWhileClosing).toBe(2);
    expect(h.transport.deleteSubscription).not.toHaveBeenCalled();
    await clock.advance(1999);
    expect(h.transport.open).toHaveBeenCalledTimes(2);
    await clock.advance(1);
    expect(h.transport.open).toHaveBeenCalledTimes(3);
    expect(await broker.reachability()).toBe(true);
    await sub.unsubscribe();
    expect(h.transport.deleteSubscription).toHaveBeenCalledOnce();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it('never deletes the shared fan-out subscription when disposing a failed recovery', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const handler = vi.fn();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
    });
    const held = Promise.withResolvers<void>();
    await broker.connect();
    const sub = await broker.subscribe('frames', handler, { fanOut: true });
    h.response.created = false;
    const queue = h.opens[0]!.name;
    vi.mocked(h.transport.open).mockImplementationOnce((_topic, _queue, _deliver, options) => {
      options!.onClosed!(undefined);
      return Promise.resolve({ close: () => held.promise, created: true });
    });
    h.opens[0]!.options!.onClosed!(undefined);
    await clock.advance(1000);
    await clock.advance(2000);
    held.resolve();
    await flushCloud();
    // Without serialization a newer stream can already be live here; the older disposal must not delete its queue.
    expect(h.transport.deleteSubscription).not.toHaveBeenCalled();
    await clock.advance(2000);
    expect(h.transport.open).toHaveBeenCalledTimes(3);
    expect(h.opens.at(-1)!.name).toBe(queue);
    const ack = vi.fn();
    h.opens.at(-1)!.deliver({ payload: '{}', ack, nack: vi.fn() });
    await flushCloud();
    expect(handler).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    await sub.unsubscribe();
    expect(h.transport.deleteSubscription).toHaveBeenCalledExactlyOnceWith(queue);
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it.each(['unsubscribe', 'disconnect'] as const)(
    'does not restart recovery after %s during disposal',
    async (kind) => {
      const h = pubSubTransport();
      const clock = clockRuntime();
      const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
      });
      const held = Promise.withResolvers<void>();
      await broker.connect();
      const sub = await broker.subscribe('frames', () => {}, { fanOut: true });
      h.response.created = false;
      vi.mocked(h.transport.open).mockImplementationOnce((_topic, _queue, _deliver, options) => {
        options!.onClosed!(undefined);
        return Promise.resolve({ close: () => held.promise, created: true });
      });
      h.opens[0]!.options!.onClosed!(undefined);
      await clock.advance(1000);
      await (kind === 'unsubscribe' ? sub.unsubscribe() : broker.disconnect());
      expect(h.transport.deleteSubscription).toHaveBeenCalledOnce();
      held.resolve();
      await flushCloud();
      await clock.advance(30000);
      expect(h.transport.open).toHaveBeenCalledTimes(2);
      expect(h.transport.deleteSubscription).toHaveBeenCalledOnce();
      await broker.disconnect();
      expect(clock.timerCount()).toBe(0);
    },
  );
});
