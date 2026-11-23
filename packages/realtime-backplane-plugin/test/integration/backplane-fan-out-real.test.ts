import { describe, expect, it } from 'vitest';
import type { IMessageBroker, RealtimeFrame } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import {
  BackplaneFanOutUnsupportedError,
  MessagingBackplane,
  RealtimeBackplanePlugin,
} from '../../src/index.ts';
import {
  FAN_OUT_ARMS,
  fanOutPair,
} from '../../../messaging-plugin/test/fixtures/fan-out-backends.ts';
import {
  REAL_FAN_OUT_ARMS,
  realFanOutEnabled,
  realFanOutPair,
  untilReal,
} from '../../../messaging-plugin/test/fixtures/real-fan-out.ts';

describe('backplane delivery through independent broker subscriptions', () => {
  it.each(FAN_OUT_ARMS)('%s fake exchanges fifty frames each way', async (arm) => {
    const h = await fanOutPair(arm);
    const received: RealtimeFrame[][] = [[], []];
    const planes = h.brokers.map(
      (broker, index) => new MessagingBackplane(broker, String(index), 'frames'),
    );
    try {
      for (let index = 0; index < 2; index++) {
        await planes[index]!.connect();
        await planes[index]!.subscribe((frame) => {
          received[index]!.push(frame);
        });
      }
      for (let index = 0; index < 50; index++)
        for (const sender of [0, 1])
          await planes[sender]!.publish({
            kind: 'ws-room',
            origin: String(sender),
            name: 'room',
            data: String(index),
          });
      await h.tick();
      expect(received.map((frames) => frames.map((frame) => frame.data))).toEqual([
        Array.from({ length: 50 }, (_, index) => String(index)),
        Array.from({ length: 50 }, (_, index) => String(index)),
      ]);
    } finally {
      for (const plane of planes) await plane.close();
      await h.close();
    }
  });
  for (const arm of REAL_FAN_OUT_ARMS) {
    it(
      `${arm} real replicas receive fifty frames each way and unsubscribe their resources`,
      { skip: !realFanOutEnabled(arm), timeout: 120000 },
      async () => {
        const h = await realFanOutPair(arm);
        const received: string[][] = [[], []];
        const planes = h.brokers.map(
          (broker, index) => new MessagingBackplane(broker, String(index), h.topic),
        );
        try {
          for (let index = 0; index < 2; index++) {
            await planes[index]!.connect();
            await planes[index]!.subscribe((frame) => {
              received[index]!.push(frame.data);
            });
          }
          for (let index = 0; index < 50; index++)
            for (const sender of [0, 1])
              await planes[sender]!.publish({
                kind: 'ws-room',
                origin: String(sender),
                name: 'room',
                data: String(index),
              });
          await untilReal(() => received.every((frames) => frames.length >= 50));
          expect(received).toEqual([
            Array.from({ length: 50 }, (_, index) => String(index)),
            Array.from({ length: 50 }, (_, index) => String(index)),
          ]);
          for (const plane of planes) await plane.close();
          expect(await h.resources()).toBe(0);
        } finally {
          for (const plane of planes) await plane.close();
          await h.close();
        }
      },
    );
  }
  it('refuses a Workers-shaped competing broker at application startup', async () => {
    const instance: IMessageBroker = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.reject(new Error('unused')),
      respond: () => Promise.reject(new Error('unused')),
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'custom', instance }),
        RealtimeBackplanePlugin({ transport: 'messaging' }),
      ],
    });
    try {
      await expect(app.start()).rejects.toBeInstanceOf(BackplaneFanOutUnsupportedError);
    } finally {
      await app.stop();
    }
  });
});
/** Real guards: REDIS_URL, RABBITMQ_URL, NATS_URL, KAFKA_BROKERS, PUBSUB_EMULATOR_HOST, SERVICEBUS_CONNECTION_STRING. */
