import { describe, expect, it, vi } from 'vitest';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { PubSubDeadLetterTopicMissingError } from '../../src/errors.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud, pubSubTransport } from '../fixtures/cloud-transports.ts';

function harness(options: ConstructorParameters<typeof GcpPubSubBroker>[2] = {}) {
  const fake = pubSubTransport();
  const clock = clockRuntime();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
    client: fake.transport,
    projectId: 'p',
    logger,
    ...options,
  });
  return { ...fake, ...clock, logger, broker };
}

describe('Pub/Sub consumer retry and dead-letter policy', () => {
  it('warns once across concurrent creates, and rechecks an earlier successful target read', async () => {
    const h = harness({ deadLetterTopic: 'dead' });
    await h.broker.connect();
    await h.broker.subscribe('first', () => {});
    vi.mocked(h.transport.topicHasSubscriptions!).mockResolvedValue(false);
    await Promise.all([
      h.broker.subscribe('second', () => {}),
      h.broker.subscribe('third', () => {}),
    ]);
    expect(h.transport.topicHasSubscriptions).toHaveBeenCalledTimes(3);
    expect(h.logger.warn).toHaveBeenCalledOnce();
    await h.broker.disconnect();
  });
  it('creates the default platform backoff and dead-letter limit', async () => {
    const h = harness({ deadLetterTopic: 'dead' });
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {
      throw new Error('secret-handler-canary');
    });
    expect(h.opens[0]!.options?.create).toEqual({
      retryPolicy: { minimumBackoffMs: 10000, maximumBackoffMs: 600000 },
      deadLetterPolicy: { deadLetterTopic: 'dead', maxDeliveryAttempts: 5 },
    });
    const nack = vi.fn();
    h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack });
    await flushCloud();
    expect(nack).toHaveBeenCalledOnce();
    expect(
      JSON.stringify([...h.logger.error.mock.calls, ...h.logger.warn.mock.calls]),
    ).not.toContain('secret-handler-canary');
    expect(h.transport.topicHasSubscriptions).toHaveBeenCalledExactlyOnceWith('dead');
    await h.broker.disconnect();
  });

  it('uses one backoff as both bounds, allows zero, and disables policies explicitly', async () => {
    for (const consumerRetry of [false, { delaysMs: [0] }] as const) {
      const h = harness({ consumerRetry });
      await h.broker.connect();
      await h.broker.subscribe('orders', () => {
        throw 'canary';
      });
      expect(h.opens[0]!.options?.create).toEqual(
        consumerRetry === false
          ? {}
          : { retryPolicy: { minimumBackoffMs: 0, maximumBackoffMs: 0 } },
      );
      const nack = vi.fn();
      h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack });
      await flushCloud();
      expect(nack).toHaveBeenCalledOnce();
      expect(h.logger.warn).toHaveBeenCalledTimes(consumerRetry === false ? 0 : 1);
      await h.broker.disconnect();
    }
  });

  it.each([
    { delaysMs: [1, 2, 3] },
    { delaysMs: [600001] },
    { delaysMs: [-1] },
    { delaysMs: [NaN] },
    { maxAttempts: 4 },
    { maxAttempts: 101 },
  ])('refuses unsupported platform policy %j', (consumerRetry) => {
    expect(() => harness({ consumerRetry, deadLetterTopic: 'dead' })).toThrow(RangeError);
  });

  it('requires a classifier target and forwards original payload before ack', async () => {
    expect(() => harness({ consumerRetry: { isRetryable: () => false } })).toThrow(
      'requires deadLetterTopic',
    );
    const h = harness({ deadLetterTopic: 'dead', consumerRetry: { isRetryable: () => false } });
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {
      throw new Error('secret-canary');
    });
    const gate = Promise.withResolvers<void>();
    vi.mocked(h.transport.publish).mockReturnValueOnce(gate.promise);
    const ack = vi.fn();
    const nack = vi.fn();
    const payload = '{ "value": 1 }';
    h.opens[0]!.deliver({ payload, attributes: { tenant: 'safe' }, ack, nack });
    await flushCloud();
    expect(ack).not.toHaveBeenCalled();
    expect(h.transport.publish).toHaveBeenCalledWith('dead', new TextEncoder().encode(payload), {
      tenant: 'safe',
      'setu-dead-letter-reason': 'not-retryable',
    });
    gate.resolve();
    await flushCloud();
    expect(ack).toHaveBeenCalledOnce();
    vi.mocked(h.transport.publish).mockRejectedValueOnce(new Error('remote-secret'));
    h.opens[0]!.deliver({ payload, ack, nack });
    await flushCloud();
    expect(nack).toHaveBeenCalledOnce();
    expect(
      JSON.stringify([...h.logger.warn.mock.calls, ...h.logger.error.mock.calls]),
    ).not.toContain('secret');
    await h.broker.disconnect();
  });

  it('bounds a terminal forward at fifteen seconds even with a shorter ordinary publish timeout', async () => {
    const h = harness({
      deadLetterTopic: 'dead',
      publishTimeoutMs: 1000,
      consumerRetry: { isRetryable: () => false },
    });
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {
      throw new Error('failed');
    });
    vi.mocked(h.transport.publish).mockReturnValueOnce(new Promise<void>(() => {}));
    const ack = vi.fn();
    const nack = vi.fn();
    h.opens[0]!.deliver({ payload: '{}', ack, nack });
    await flushCloud();
    expect(nack).not.toHaveBeenCalled();
    await h.advance(1000);
    expect(nack).not.toHaveBeenCalled();
    await h.advance(13999);
    expect(nack).not.toHaveBeenCalled();
    await h.advance(1);
    await flushCloud();
    expect(nack).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    await h.broker.disconnect();
  });

  it('a throwing classifier retains retry and a settlement failure is separate', async () => {
    const h = harness({
      deadLetterTopic: 'dead',
      consumerRetry: {
        isRetryable: () => {
          throw new Error('secret');
        },
      },
    });
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {
      throw 1;
    });
    const nack = vi.fn();
    h.opens[0]!.deliver({ payload: '{}', ack: vi.fn(), nack });
    await flushCloud();
    expect(nack).toHaveBeenCalledOnce();
    expect(h.logger.error).toHaveBeenCalledWith('Pub/Sub retry classifier failed');
    h.opens[0]!.deliver({
      payload: '{}',
      ack: vi.fn(),
      nack: () => {
        throw 1;
      },
    });
    await flushCloud();
    expect(h.logger.error).toHaveBeenCalledWith('Pub/Sub message settlement failed');
    await h.broker.disconnect();
  });

  it.each([5, 7, 13, undefined])(
    'inspects only after a create failure, independent of code %s',
    async (code) => {
      const h = harness({ deadLetterTopic: 'dead' });
      const cause = Object.assign(
        new Error('private-sdk-text'),
        code === undefined ? {} : { code },
      );
      vi.mocked(h.transport.open).mockRejectedValue(cause);
      vi.mocked(h.transport.topicExists!).mockResolvedValue(false);
      await h.broker.connect();
      const refusal = await h.broker.subscribe('orders', () => {}).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PubSubDeadLetterTopicMissingError);
      expect((refusal as Error).cause).toBe(cause);
      expect((refusal as Error).message).toContain('dead');
      expect((refusal as Error).message).not.toContain('private-sdk-text');
      await h.broker.disconnect();
    },
  );

  it.each(['exists', 'inspection-rejects', 'no-inspector', 'already-exists'])(
    'names missing topics and preserves other create failures: %s',
    async (kind) => {
      const h = harness({ deadLetterTopic: 'dead' });
      const cause = Object.assign(new Error('create failed'), {
        code: kind === 'already-exists' ? 6 : 5,
      });
      vi.mocked(h.transport.open).mockRejectedValue(cause);
      if (kind === 'inspection-rejects')
        vi.mocked(h.transport.topicExists!).mockRejectedValue(new Error('inspect-secret'));
      if (kind === 'no-inspector') delete h.transport.topicExists;
      await h.broker.connect();
      if (kind === 'already-exists')
        await expect(h.broker.subscribe('orders', () => {})).rejects.toBe(cause);
      else
        await expect(h.broker.subscribe('orders', () => {})).rejects.toMatchObject({
          name: 'PubSubTopicMissingError',
          topic: 'orders',
          cause,
        });
      expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain('inspect-secret');
      await h.broker.disconnect();
    },
  );

  it.each([false, undefined])('attaches without target reads for created=%s', async (created) => {
    const h = harness({ deadLetterTopic: 'dead' });
    if (created === undefined) delete h.response.created;
    else h.response.created = created;
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {});
    await h.broker.subscribe('orders', () => {});
    expect(h.transport.topicExists).not.toHaveBeenCalled();
    expect(h.transport.topicHasSubscriptions).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledOnce();
    await h.broker.disconnect();
  });

  it('leaves matching existing policies unchanged without warning', async () => {
    const h = harness({ deadLetterTopic: 'dead' });
    h.response.created = false;
    h.response.existing = {
      retryPolicy: { minimumBackoffMs: 10000, maximumBackoffMs: 600000 },
      deadLetterPolicy: { deadLetterTopic: 'projects/p/topics/dead', maxDeliveryAttempts: 5 },
    };
    await h.broker.connect();
    await h.broker.subscribe('orders', () => {});
    expect(h.logger.warn).not.toHaveBeenCalled();
    await h.broker.disconnect();
  });

  it.each(['empty', 'permission', 'failure', 'missing-method'])(
    'checks a created target once: %s',
    async (kind) => {
      const h = harness({ deadLetterTopic: 'dead' });
      if (kind === 'empty') vi.mocked(h.transport.topicHasSubscriptions!).mockResolvedValue(false);
      if (kind === 'permission' || kind === 'failure')
        vi.mocked(h.transport.topicHasSubscriptions!).mockRejectedValue({
          code: kind === 'permission' ? 7 : 13,
          message: 'secret',
        });
      if (kind === 'missing-method') delete h.transport.topicHasSubscriptions;
      await h.broker.connect();
      await h.broker.subscribe('orders', () => {});
      await h.broker.subscribe('other', () => {});
      expect(kind === 'permission' ? h.logger.info : h.logger.warn).toHaveBeenCalledOnce();
      if (kind === 'permission') {
        expect(h.logger.info).toHaveBeenCalledWith(
          expect.stringContaining('grant roles/pubsub.viewer on the topic'),
        );
        expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain('listSubscriptions');
      }
      if (kind === 'empty' || kind === 'missing-method')
        expect(h.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'dead letters are lost unless the topic has a subscription or message retention enabled',
          ),
        );
      expect(
        JSON.stringify([...h.logger.warn.mock.calls, ...h.logger.info.mock.calls]),
      ).not.toContain('secret');
      await h.broker.disconnect();
    },
  );

  it('falls back to error for warn, drops missing info, and swallows failed sinks', async () => {
    for (const code of [7, 13]) {
      const error = vi.fn();
      const h = harness({ deadLetterTopic: 'dead', logger: { error } });
      vi.mocked(h.transport.topicHasSubscriptions!).mockRejectedValue({ code });
      await h.broker.connect();
      await h.broker.subscribe('orders', () => {});
      expect(error).toHaveBeenCalledTimes(code === 7 ? 0 : 1);
      await h.broker.disconnect();
    }
    const h = harness({
      logger: {
        error: () => {
          throw 1;
        },
      },
    });
    await h.broker.connect();
    await h.broker.disconnect();
  });

  it('fan-out and producer-only paths never inspect the dead-letter topic', async () => {
    const h = harness({ deadLetterTopic: 'dead' });
    await h.broker.connect();
    await h.broker.publish('orders', {});
    expect(h.transport.topicHasSubscriptions).not.toHaveBeenCalled();
    const subscription = await h.broker.subscribe(
      'orders',
      () => {
        throw 1;
      },
      { fanOut: true },
    );
    expect(subscription.fanOut).toBe(true);
    expect(h.opens[0]!.options?.create).toEqual({
      messageRetentionSeconds: 600,
      expirationTtlSeconds: 86400,
      retryPolicy: { minimumBackoffMs: 10000, maximumBackoffMs: 600000 },
    });
    expect(h.transport.topicHasSubscriptions).not.toHaveBeenCalled();
    const ack = vi.fn();
    h.opens[0]!.deliver({ payload: '{}', ack, nack: vi.fn() });
    await flushCloud();
    await subscription.unsubscribe();
    expect(h.transport.deleteSubscription).toHaveBeenCalledExactlyOnceWith(h.opens[0]!.name);
    h.opens[0]!.deliver({ payload: '{}', ack, nack: vi.fn() });
    await flushCloud();
    expect(ack).not.toHaveBeenCalled();
    await h.broker.disconnect();
  });
});
