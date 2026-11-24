import { describe, expect, it } from 'vitest';
import { resolveConsumerRetry } from '../../src/brokers/consumer-retry.ts';
import { resolveConsumerOptions } from '../../src/brokers/rabbitmq-broker.ts';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type { ConsumerRetryOptions } from '../../src/interfaces/index.ts';

describe('consumer retry validation', () => {
  it.each(['RabbitMqBroker', 'RedisStreamsBroker', 'GcpPubSubBroker', 'ServiceBusBroker'])(
    'refuses non-array delays for %s with RangeError',
    (broker) => {
      for (const delaysMs of [5000, {}, 'secret', null]) {
        expect(() =>
          resolveConsumerRetry({ delaysMs: delaysMs as never }, broker, { defaults: [1] }),
        ).toThrow(RangeError);
        expect(() =>
          resolveConsumerRetry({ delaysMs: delaysMs as never }, broker, { defaults: [1] }),
        ).toThrow(`${broker} consumerRetry.delaysMs must be an array`);
      }
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity])(
    'refuses invalid budgets %s in both existing arms',
    (maxAttempts) => {
      expect(() => resolveConsumerOptions({ consumerRetry: { maxAttempts } })).toThrow(
        'RabbitMqBroker consumerRetry.maxAttempts must be a positive integer within its bound',
      );
      expect(
        () =>
          new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
            consumerRetry: { maxAttempts },
          }),
      ).toThrow(
        'RedisStreamsBroker consumerRetry.maxAttempts must be a positive integer within its bound',
      );
    },
  );
  it.each([[], [0], [NaN], [Infinity], [2, 1], [2147483648]].map((delaysMs) => ({ delaysMs })))(
    'preserves both existing delay refusals $delaysMs',
    ({ delaysMs }) => {
      for (const label of ['RabbitMqBroker', 'RedisStreamsBroker']) {
        const act =
          label === 'RabbitMqBroker'
            ? () => resolveConsumerOptions({ consumerRetry: { delaysMs } })
            : () =>
                new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
                  consumerRetry: { delaysMs },
                });
        expect(act).toThrow(
          label +
            ' consumerRetry.delaysMs must be ' +
            (delaysMs.length === 0
              ? 'nonempty'
              : delaysMs.length === 2
                ? 'nondecreasing'
                : 'a positive integer within its bound'),
        );
      }
    },
  );
  it('rejects malformed policies and classifiers without echoing them', () => {
    for (const value of [null, 'secret', 7])
      expect(() =>
        resolveConsumerRetry(value as unknown as ConsumerRetryOptions, 'Broker', { defaults: [1] }),
      ).toThrow('must be false or an options object');
    expect(() =>
      resolveConsumerRetry({ isRetryable: 'secret' as unknown as () => boolean }, 'Broker', {
        defaults: [1],
      }),
    ).toThrow('isRetryable must be a function');
    expect(resolveConsumerRetry(false, 'Broker', { defaults: [1] }).retry).toBe(false);
    expect(
      resolveConsumerRetry({ maxAttempts: 2, delaysMs: [0, 2] }, 'Broker', {
        defaults: [1],
        minDelay: 0,
      }).delaysMs,
    ).toEqual([0, 2]);
  });
});
