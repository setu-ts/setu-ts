import { describe, expect, it, vi } from 'vitest';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud, serviceBusTransport } from '../fixtures/cloud-transports.ts';

function harness(options: ConstructorParameters<typeof ServiceBusBroker>[2] = {}) {
  const fake = serviceBusTransport();
  const clock = clockRuntime();
  const logger = { error: vi.fn(), warn: vi.fn() };
  const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
    client: fake.transport,
    logger,
    ...options,
  });
  return { ...fake, ...clock, logger, broker };
}

describe('Service Bus consumer retry', () => {
  it('treats deliveryCount as prior deliveries, holding first through fourth and dead-lettering fifth', async () => {
    const h = harness();
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {
      throw new Error('secret-canary');
    });
    const nack = vi.fn();
    const deadLetter = vi.fn(() => Promise.resolve());
    const delays = [1000, 5000, 30000, 120000];
    for (let deliveryCount = 0; deliveryCount < 5; deliveryCount++) {
      const completion = h.opens[0]!.deliver({
        payload: '{}',
        ack: vi.fn(),
        nack,
        deadLetter,
        deliveryCount,
      });
      await flushCloud();
      if (deliveryCount < 4) {
        expect(nack).toHaveBeenCalledTimes(deliveryCount);
        await h.advance(delays[deliveryCount]! - 1);
        expect(nack).toHaveBeenCalledTimes(deliveryCount);
        await h.advance(1);
      }
      await completion;
    }
    expect(nack).toHaveBeenCalledTimes(4);
    expect(deadLetter).toHaveBeenCalledExactlyOnceWith('setu-attempts-exhausted');
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain('secret-canary');
    await h.broker.disconnect();
    expect(h.timerCount()).toBe(0);
  });

  it('repeats the last delay and clamps attempts to platform maxDeliveryCount', async () => {
    const h = harness({ consumerRetry: { maxAttempts: 9, delaysMs: [10] } });
    vi.mocked(h.transport.getSubscription!).mockResolvedValue({ maxDeliveryCount: 3 });
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {
      throw 1;
    });
    const nack = vi.fn();
    const deadLetter = vi.fn(() => Promise.resolve());
    for (const deliveryCount of [0, 1, 2]) {
      const done = h.opens[0]!.deliver({
        payload: '{}',
        deliveryCount,
        ack: vi.fn(),
        nack,
        deadLetter,
      });
      await flushCloud();
      await h.advance(10);
      await done;
    }
    expect(nack).toHaveBeenCalledTimes(2);
    expect(deadLetter).toHaveBeenCalledOnce();
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Service Bus consumerRetry.maxAttempts clamped to subscription maxDeliveryCount',
    );
    await h.broker.disconnect();
  });

  it.each([240000, Infinity, NaN, -1, 0.5])('refuses an unsafe hold %s', (delay) => {
    expect(() => harness({ consumerRetry: { delaysMs: [delay] } })).toThrow(RangeError);
  });

  it('abandons immediately when handler time consumed the lock budget and warns once', async () => {
    const h = harness({ consumerRetry: { delaysMs: [1000] } });
    const work = Promise.withResolvers<void>();
    await h.broker.connect();
    await h.broker.subscribe('orders', async () => {
      await work.promise;
      throw 1;
    });
    const nack = vi.fn();
    const done = h.opens[0]!.deliver({
      payload: '{}',
      deliveryCount: 0,
      ack: vi.fn(),
      nack,
      deadLetter: vi.fn(),
    });
    await h.advance(239001);
    work.resolve();
    await done;
    expect(nack).toHaveBeenCalledOnce();
    expect(h.timerCount()).toBe(0);
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Service Bus retry delay exceeds remaining lock renewal budget; abandoning immediately',
    );
    await h.broker.disconnect();
  });

  it.each(['unsubscribe', 'disconnect'])(
    'cancels holds and abandons before receiver close on %s',
    async (kind) => {
      const h = harness();
      await h.broker.connect();
      const sub = await h.broker.subscribe('orders', () => {
        throw 1;
      });
      const order: string[] = [];
      const nack = vi.fn(() => {
        order.push('nack');
      });
      h.opens[0]!.close.mockImplementation(() => {
        order.push('close');
        return Promise.resolve();
      });
      const done = h.opens[0]!.deliver({
        payload: '{}',
        deliveryCount: 0,
        ack: vi.fn(),
        nack,
        deadLetter: vi.fn(),
      });
      await flushCloud();
      expect(h.timerCount()).toBe(1);
      await (kind === 'unsubscribe' ? sub.unsubscribe() : h.broker.disconnect());
      await done;
      expect(order).toEqual(['nack', 'close']);
      expect(h.timerCount()).toBe(0);
      await h.advance(1000000);
      expect(nack).toHaveBeenCalledOnce();
      await h.broker.disconnect();
    },
  );

  it('swallows a teardown abandon failure and never settles held work twice', async () => {
    const h = harness();
    await h.broker.connect();
    const sub = await h.broker.subscribe('orders', () => {
      throw 1;
    });
    const nack = vi.fn(() => {
      throw 1;
    });
    const done = h.opens[0]!.deliver({
      payload: '{}',
      deliveryCount: 0,
      ack: vi.fn(),
      nack,
      deadLetter: vi.fn(),
    });
    await flushCloud();
    await sub.unsubscribe();
    await sub.unsubscribe();
    await done;
    expect(nack).toHaveBeenCalledOnce();
    await h.broker.disconnect();
  });

  it.each([undefined, -1, 1.5, NaN, Infinity])(
    'legacy or invalid deliveryCount %s falls back once',
    async (deliveryCount) => {
      const h = harness();
      await h.broker.connect();
      await h.broker.subscribe('orders', () => {
        throw 1;
      });
      const nack = vi.fn();
      for (let n = 0; n < 2; n++)
        await h.opens[0]!.deliver({
          payload: '{}',
          ack: vi.fn(),
          nack,
          deadLetter: vi.fn(),
          ...(deliveryCount === undefined ? {} : { deliveryCount }),
        });
      expect(nack).toHaveBeenCalledTimes(2);
      expect(h.logger.warn).toHaveBeenCalledOnce();
      await h.broker.disconnect();
    },
  );

  it('missing deadLetter falls back, disabled retries ignore transport count, classifier false dead-letters', async () => {
    for (const mode of ['missing', 'disabled', 'non-retryable', 'classifier-throws'] as const) {
      const h = harness({
        consumerRetry:
          mode === 'disabled'
            ? false
            : {
                isRetryable: () => {
                  if (mode === 'classifier-throws') throw 1;
                  return false;
                },
                delaysMs: [1],
              },
      });
      delete h.transport.getSubscription;
      await h.broker.connect();
      await h.broker.subscribe('orders', () => {
        throw 1;
      });
      const nack = vi.fn();
      const deadLetter = vi.fn(() => Promise.resolve());
      const done = h.opens[0]!.deliver({
        payload: '{}',
        deliveryCount: 0,
        ack: vi.fn(),
        nack,
        ...(mode === 'missing' ? {} : { deadLetter }),
      });
      await flushCloud();
      await h.advance(1);
      await done;
      expect(deadLetter).toHaveBeenCalledTimes(mode === 'non-retryable' ? 1 : 0);
      if (mode === 'non-retryable') expect(deadLetter).toHaveBeenCalledWith('setu-not-retryable');
      else expect(nack).toHaveBeenCalledOnce();
      await h.broker.disconnect();
    }
  });

  it('keeps configured budget on failed or malformed admin reads and supports an error-only logger', async () => {
    for (const budget of [NaN, 0, 1.5, undefined]) {
      const error = vi.fn();
      const h = harness({ logger: { error } });
      vi.mocked(h.transport.getSubscription!).mockResolvedValue(
        budget === undefined ? {} : { maxDeliveryCount: budget },
      );
      await h.broker.connect();
      await h.broker.subscribe('orders', () => {});
      const ack = vi.fn();
      await h.opens[0]!.deliver({ payload: '{}', ack, nack: vi.fn() });
      expect(ack).toHaveBeenCalledOnce();
      await h.broker.disconnect();
    }
    const error = vi.fn();
    const h = harness({ logger: { error } });
    vi.mocked(h.transport.getSubscription!).mockRejectedValue(new Error('secret'));
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {});
    expect(error).toHaveBeenCalledOnce();
    await h.broker.disconnect();
  });
});
