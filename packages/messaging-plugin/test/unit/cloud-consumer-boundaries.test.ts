import { describe, expect, it, vi } from 'vitest';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import { PubSubOrdering } from '../../src/brokers/pubsub-ordering.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud, pubSubTransport, serviceBusTransport } from '../fixtures/cloud-transports.ts';

describe('Cloud consumer lifecycle boundaries', () => {
  it('cancels a terminal forward timer when the initial stream closes before setup commits', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const opened = Promise.withResolvers<{ close(): Promise<void>; created: boolean }>();
    let closed = (): void => {};
    vi.mocked(h.transport.publish).mockReturnValue(new Promise(() => {}));
    vi.mocked(h.transport.open).mockImplementationOnce((_t, _q, deliver, options) => {
      closed = () => options!.onClosed!(undefined);
      deliver({ payload: '{}', ack: vi.fn(), nack: vi.fn() });
      return opened.promise;
    });
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      deadLetterTopic: 'dead',
      consumerRetry: { isRetryable: () => false },
    });
    await broker.connect();
    const pending = broker.subscribe('orders', () => {
      throw new Error('terminal');
    });
    const refusal = expect(pending).rejects.toThrow('closed while opening');
    await flushCloud();
    expect(clock.timerCount()).toBe(1);
    closed();
    opened.resolve({ close: () => Promise.resolve(), created: true });
    await refusal;
    await flushCloud();
    expect(clock.timerCount()).toBe(0);
    await broker.disconnect();
  });
  it('does not open a recovery stream while the first setup is still pending', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const opened = Promise.withResolvers<{ close(): Promise<void>; created: boolean }>();
    vi.mocked(h.transport.open).mockImplementationOnce((_t, _q, _d, options) => {
      options!.onClosed!(undefined);
      return opened.promise;
    });
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
    });
    await broker.connect();
    const pending = broker.subscribe('orders', () => {}, { fanOut: true });
    const refusal = expect(pending).rejects.toThrow('closed while opening');
    await flushCloud();
    await clock.advance(5000);
    expect(h.transport.open).toHaveBeenCalledOnce();
    const close = vi.fn(() => Promise.resolve());
    opened.resolve({ close, created: true });
    await refusal;
    expect(close).toHaveBeenCalledOnce();
    expect(h.transport.deleteSubscription).toHaveBeenCalledOnce();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
  it('cancels a pending topic diagnostic on disconnect and closes the late stream', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    vi.mocked(h.transport.topicHasSubscriptions!).mockReturnValue(new Promise(() => {}));
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      deadLetterTopic: 'dead',
    });
    await broker.connect();
    const pending = broker.subscribe('orders', () => {});
    const refusal = expect(pending).rejects.toThrow('disconnected while subscribing');
    await flushCloud();
    expect(clock.timerCount()).toBe(1);
    await broker.disconnect();
    await refusal;
    expect(h.opens[0]!.close).toHaveBeenCalledOnce();
    expect(clock.timerCount()).toBe(0);
  });
  it('handles a replacement stream delivery before open resolves and ignores the old generation', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const handler = vi.fn();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      consumerRetry: false,
    });
    await broker.connect();
    await broker.subscribe('orders', handler);
    h.opens[0]!.options!.onClosed!(undefined);
    const ack = vi.fn();
    const nack = vi.fn();
    vi.mocked(h.transport.open).mockImplementationOnce((_t, _q, deliver) => {
      deliver({ payload: '{}', ack, nack });
      return Promise.resolve({ close: () => Promise.resolve(), created: true });
    });
    await clock.advance(1000);
    expect(handler).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    h.opens[0]!.deliver({ payload: '{}', ack, nack });
    await flushCloud();
    expect(handler).toHaveBeenCalledOnce();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it('preserves the same-key completion barrier across clear while other keys run', async () => {
    const gate = new PubSubOrdering(() => 0);
    const held = Promise.withResolvers<boolean>();
    const first = gate.run(
      { orderingKey: 'k', messageId: 'first', nack: vi.fn() },
      () => held.promise,
    );
    await flushCloud();
    gate.clear();
    const second = vi.fn(() => Promise.resolve(true));
    const next = gate.run({ orderingKey: 'k', messageId: 'next', nack: vi.fn() }, second);
    const other = vi.fn(() => Promise.resolve(true));
    await gate.run({ orderingKey: 'other', nack: vi.fn() }, other);
    expect(other).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    held.resolve(false);
    await first;
    await next;
    expect(second).toHaveBeenCalledOnce();
  });

  it('retains at most one thousand nacked identities per key and still releases an early redelivery', async () => {
    const gate = new PubSubOrdering(() => 0);
    const nack = vi.fn();
    await gate.run({ orderingKey: 'k', messageId: 'head', nack }, () => Promise.resolve(false));
    for (let i = 0; i < 1050; i++)
      await gate.run({ orderingKey: 'k', messageId: String(i), nack }, () => Promise.resolve(true));
    const dispatch = vi.fn(() => Promise.resolve(true));
    await gate.run({ orderingKey: 'k', messageId: '999', nack }, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    await gate.run({ orderingKey: 'k', messageId: '0', nack }, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    gate.clear();
  });

  it('retries when a replacement closes between its open and recovery commit', async () => {
    // Sweep the promise-continuation boundary, including the microtask just after open's check.
    for (let offset = 0; offset < 12; offset++) {
      const h = pubSubTransport();
      const clock = clockRuntime();
      const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
        consumerRetry: false,
      });
      await broker.connect();
      await broker.subscribe('orders', () => {});
      h.opens[0]!.options!.onClosed!(undefined);
      vi.mocked(h.transport.open).mockImplementationOnce((_t, _q, _d, options) => {
        let chain = Promise.resolve();
        for (let n = 0; n < offset; n++) chain = chain.then(() => {});
        void chain.then(() => options!.onClosed!(undefined));
        return Promise.resolve({ close: () => Promise.resolve(), created: false });
      });
      await clock.advance(1000);
      expect(await broker.reachability(), `offset ${offset}`).toBe(false);
      await clock.advance(2000);
      expect(h.transport.open, `offset ${offset}`).toHaveBeenCalledTimes(3);
      await broker.disconnect();
      expect(clock.timerCount()).toBe(0);
    }
  });

  it('bounds the dead-letter topic diagnostic without blocking consumption forever', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    const warn = vi.fn();
    vi.mocked(h.transport.topicHasSubscriptions!).mockReturnValue(new Promise(() => {}));
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      deadLetterTopic: 'dead',
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    let ready = false;
    const pending = broker
      .subscribe('orders', () => {})
      .then((sub) => {
        ready = true;
        return sub;
      });
    await flushCloud();
    await clock.advance(1500);
    expect(ready).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    await (await pending).unsubscribe();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it.each([true, false])(
    'deletes only a created fan-out subscription when its first stream closes (created=%s)',
    async (created) => {
      const h = pubSubTransport();
      const clock = clockRuntime();
      vi.mocked(h.transport.open).mockImplementationOnce((_t, _q, _d, options) => {
        options!.onClosed!(undefined);
        return Promise.resolve({ close: () => Promise.resolve(), created });
      });
      const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
        client: h.transport,
      });
      await broker.connect();
      await expect(broker.subscribe('orders', () => {}, { fanOut: true })).rejects.toThrow(
        'closed while opening',
      );
      expect(h.transport.deleteSubscription).toHaveBeenCalledTimes(created ? 1 : 0);
      await broker.disconnect();
      expect(clock.timerCount()).toBe(0);
    },
  );

  it('bounds a terminal forward at fifteen seconds when ordinary publishing is unbounded', async () => {
    const h = pubSubTransport();
    const clock = clockRuntime();
    vi.mocked(h.transport.publish).mockReturnValue(new Promise(() => {}));
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      publishTimeoutMs: 0,
      deadLetterTopic: 'dead',
      consumerRetry: { isRetryable: () => false },
    });
    await broker.connect();
    await broker.subscribe('orders', () => {
      throw new Error('terminal');
    });
    const ack = vi.fn();
    const nack = vi.fn();
    h.opens[0]!.deliver({ payload: '{}', ack, nack });
    await flushCloud();
    await clock.advance(14999);
    expect(nack).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(nack).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it('bounds Service Bus subscription inspection and retains the configured budget', async () => {
    const h = serviceBusTransport();
    const clock = clockRuntime();
    const warn = vi.fn();
    vi.mocked(h.transport.getSubscription!).mockReturnValue(new Promise(() => {}));
    const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
      client: h.transport,
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    const pending = broker.subscribe('orders', () => {});
    await flushCloud();
    await clock.advance(4999);
    expect(h.transport.open).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(h.transport.open).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('configured retry budget retained'));
    await (await pending).unsubscribe();
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });
});
