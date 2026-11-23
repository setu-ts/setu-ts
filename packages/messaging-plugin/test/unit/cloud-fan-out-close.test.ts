import { describe, expect, it, vi } from 'vitest';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { pubSubTransport, serviceBusTransport } from '../fixtures/cloud-transports.ts';

/** A delete failure carrying remote text that must never reach a log line. */
const deleteFailure = Object.assign(new Error('remote secret text'), {
  code: 'ServiceUnavailable',
});

describe('closing cloud fan-out subscriptions when the admin delete fails', () => {
  it('Service Bus: disconnect closes every receiver and the transport, warning without remote text', async () => {
    const fake = serviceBusTransport();
    vi.mocked(fake.transport.deleteSubscription).mockRejectedValue(deleteFailure);
    const warn = vi.fn();
    const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: fake.transport,
      consumerRetry: false,
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    for (const topic of ['a', 'b', 'c']) await broker.subscribe(topic, () => {}, { fanOut: true });
    await broker.disconnect();
    expect(fake.opens.every((open) => open.close.mock.calls.length === 1)).toBe(true);
    expect(fake.transport.close).toHaveBeenCalledOnce();
    expect(broker.isReady()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('was not deleted (ServiceUnavailable)'),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('remote secret text');
  });

  it('Pub/Sub: disconnect closes every subscription and the transport, warning with the code only', async () => {
    const fake = pubSubTransport();
    vi.mocked(fake.transport.deleteSubscription).mockRejectedValue(
      Object.assign(deleteFailure, { code: 14 }),
    );
    const warn = vi.fn();
    const broker = new GcpPubSubBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: fake.transport,
      projectId: 'p',
      consumerRetry: false,
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    for (const topic of ['a', 'b', 'c']) await broker.subscribe(topic, () => {}, { fanOut: true });
    await broker.disconnect();
    expect(fake.opens.every((open) => open.close.mock.calls.length === 1)).toBe(true);
    expect(fake.transport.close).toHaveBeenCalledOnce();
    expect(broker.isReady()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not deleted (code 14)'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('remote secret text');
  });

  it('Pub/Sub: a deadLetterTopic with consumerRetry false warns once that it is ignored', async () => {
    const fake = pubSubTransport();
    const warn = vi.fn();
    const broker = new GcpPubSubBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: fake.transport,
      projectId: 'p',
      consumerRetry: false,
      deadLetterTopic: 'dead',
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Pub/Sub deadLetterTopic is ignored because consumerRetry is false',
    );
    await broker.disconnect();
  });
});
