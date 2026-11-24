import {
  REAL_FAN_OUT_ARMS,
  realFanOutEnabled,
  realFanOutPair,
  untilReal,
} from '../fixtures/real-fan-out.ts';
import { describe, expect, it } from 'vitest';
import * as messaging from '../../src/index.ts';
import { FAN_OUT_ARMS, fanOutPair } from '../fixtures/fan-out-backends.ts';

describe('independent subscription conformance', () => {
  it('covers every exported first-party broker', () => {
    const exported = Object.keys(messaging)
      .filter((name) => name.endsWith('Broker'))
      .sort();
    expect(exported).toEqual([
      'GcpPubSubBroker',
      'InMemoryBroker',
      'KafkaBroker',
      'NatsBroker',
      'RabbitMqBroker',
      'RedisStreamsBroker',
      'ServiceBusBroker',
    ]);
    expect(FAN_OUT_ARMS).toHaveLength(exported.length);
  });
  it.each(FAN_OUT_ARMS)('%s gives each subscriber every new publication', async (arm) => {
    const h = await fanOutPair(arm);
    const received: number[][] = [[], []];
    try {
      const subscriptions = await Promise.all(
        h.brokers.map((broker, index) =>
          broker.subscribe<number>(
            'frames',
            (message) => {
              received[index]!.push(message);
            },
            { fanOut: true },
          ),
        ),
      );
      expect(subscriptions.every((subscription) => subscription.fanOut === true)).toBe(true);
      for (let index = 0; index < 10; index++) await h.brokers[index % 2]!.publish('frames', index);
      await h.tick();
      expect(received).toEqual([
        Array.from({ length: 10 }, (_, index) => index),
        Array.from({ length: 10 }, (_, index) => index),
      ]);
      for (const subscription of subscriptions) await subscription.unsubscribe();
      if (!['memory', 'redis-streams', 'kafka'].includes(arm)) expect(h.resourceCount()).toBe(0);
    } finally {
      await h.close();
    }
  });
  it.each(['redis-streams', 'nats', 'kafka', 'pubsub', 'service-bus'] as const)(
    '%s without fanOut competes on its default group',
    async (arm) => {
      const h = await fanOutPair(arm);
      const received: number[][] = [[], []];
      try {
        for (let index = 0; index < 2; index++)
          await h.brokers[index]!.subscribe<number>('frames', (message) => {
            received[index]!.push(message);
          });
        for (let index = 0; index < 10; index++) await h.brokers[0].publish('frames', index);
        await h.tick();
        expect(received[0]!.length + received[1]!.length).toBe(10);
        expect(received.every((messages) => messages.length === 10)).toBe(false);
      } finally {
        await h.close();
      }
    },
  );
});

for (const arm of REAL_FAN_OUT_ARMS) {
  it(
    arm + ' real consumers receive every independent publication',
    { skip: !realFanOutEnabled(arm), timeout: 120000 },
    async () => {
      const h = await realFanOutPair(arm);
      const received: number[][] = [[], []];
      const subscriptions = [];
      try {
        for (let index = 0; index < 2; index++)
          subscriptions.push(
            await h.brokers[index]!.subscribe<number>(
              h.topic,
              (message) => {
                received[index]!.push(message);
              },
              { fanOut: true },
            ),
          );
        for (let index = 0; index < 10; index++)
          await h.brokers[index % 2]!.publish(h.topic, index);
        await untilReal(() => received.every((values) => values.length >= 10));
        expect(received).toEqual([
          Array.from({ length: 10 }, (_, index) => index),
          Array.from({ length: 10 }, (_, index) => index),
        ]);
        for (const subscription of subscriptions) await subscription.unsubscribe();
        expect(await h.resources()).toBe(0);
      } finally {
        for (const subscription of subscriptions) await subscription.unsubscribe();
        await h.close();
      }
    },
  );
}
/** Real guards: REDIS_URL, RABBITMQ_URL, NATS_URL, KAFKA_BROKERS, PUBSUB_EMULATOR_HOST, SERVICEBUS_CONNECTION_STRING. */
