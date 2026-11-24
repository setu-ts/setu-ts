import { describe, expect, it, vi } from 'vitest';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import { SubscriptionNameExistsError } from '../../src/brokers/fan-out.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { serviceBusTransport } from '../fixtures/cloud-transports.ts';

describe('Service Bus independent subscription names', () => {
  it('shortens and trims the owner, retries a classified collision once, and deletes on unsubscribe', async () => {
    const fake = serviceBusTransport();
    const clock = clockRuntime();
    const uuid = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValue('33333333-3333-4333-8333-333333333333');
    const broker = new ServiceBusBroker({ ...clock.runtime, uuid }, new JsonSerializer(), {
      client: fake.transport,
      defaultQueue: '--' + 'a'.repeat(38),
      consumerRetry: false,
    });
    vi.mocked(fake.transport.createSubscription).mockRejectedValueOnce(
      new SubscriptionNameExistsError({ code: 'MessageEntityAlreadyExistsError' }),
    );
    await broker.connect();
    const sub = await broker.subscribe('orders', () => {}, { fanOut: true });
    const names = vi.mocked(fake.transport.createSubscription).mock.calls.map((call) => call[1]);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    for (const name of names) {
      expect(name).toMatch(/^a{28}-fanout-[a-f0-9]{12}$/u);
      expect(name.length).toBeLessThanOrEqual(50);
    }
    expect(fake.transport.createSubscription).toHaveBeenLastCalledWith('orders', names[1], {
      autoDeleteOnIdleMs: 300000,
    });
    expect(sub.fanOut).toBe(true);
    await sub.unsubscribe();
    expect(fake.transport.deleteSubscription).toHaveBeenCalledExactlyOnceWith('orders', names[1]);
    await broker.disconnect();
  });
  it.each(['collision', 'forbidden', 'generic-conflict'])(
    'does not retry beyond the classified single collision: %s',
    async (kind) => {
      const fake = serviceBusTransport();
      const clock = clockRuntime();
      const warn = vi.fn();
      const failure =
        kind === 'collision'
          ? new SubscriptionNameExistsError({})
          : Object.assign(new Error('secret'), {
              name: 'RestError',
              statusCode: kind === 'forbidden' ? 403 : 409,
            });
      vi.mocked(fake.transport.createSubscription).mockRejectedValue(failure);
      const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
        client: fake.transport,
        consumerRetry: false,
        logger: { error: vi.fn(), warn },
      });
      await broker.connect();
      await expect(broker.subscribe('orders', () => {}, { fanOut: true })).rejects.toBe(failure);
      expect(fake.transport.createSubscription).toHaveBeenCalledTimes(kind === 'collision' ? 2 : 1);
      expect(fake.transport.open).not.toHaveBeenCalled();
      if (kind === 'forbidden')
        expect(warn).toHaveBeenCalledWith(
          'Service Bus fanOut subscription creation was refused; the identity needs Manage rights',
        );
      if (kind === 'generic-conflict')
        expect(warn).toHaveBeenCalledWith(
          'Service Bus fanOut subscription creation failed (status 409)',
        );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      await broker.disconnect();
    },
  );
  it('deletes a creation completing after disconnect and closes a late receiver', async () => {
    for (const stage of ['create', 'open']) {
      const fake = serviceBusTransport();
      const clock = clockRuntime();
      const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
        client: fake.transport,
        consumerRetry: false,
      });
      const gate = Promise.withResolvers<void>();
      const close = vi.fn(() => Promise.resolve());
      if (stage === 'create')
        vi.mocked(fake.transport.createSubscription).mockReturnValueOnce(gate.promise);
      else
        vi.mocked(fake.transport.open).mockImplementationOnce(async () => {
          await gate.promise;
          return { close };
        });
      await broker.connect();
      const subscribing = broker.subscribe('orders', () => {}, { fanOut: true });
      for (let n = 0; n < 20; n++) await Promise.resolve();
      await broker.disconnect();
      gate.resolve();
      await expect(subscribing).rejects.toThrow('disconnected while subscribing');
      expect(fake.transport.deleteSubscription).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledTimes(stage === 'open' ? 1 : 0);
    }
  });
});
