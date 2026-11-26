import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin, adaptServiceBusModule } from '../../src/index.ts';
import { serviceBusSdk } from '../fixtures/service-bus-sdk.ts';
import { resolveServiceBusConcurrency } from '../../src/brokers/service-bus-faults.ts';

describe('Service Bus concurrency', () => {
  it.each([undefined, 4])(
    'forwards %s through plugin, broker and SDK subscribe',
    async (maxConcurrentCalls) => {
      const sdk = serviceBusSdk();
      const transport = adaptServiceBusModule(sdk.module, {
        connectionString: 'x',
        adminConnectionString: 'x',
      });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({
            broker: 'service-bus',
            client: transport,
            ...(maxConcurrentCalls === undefined ? {} : { maxConcurrentCalls }),
            subscriptions: [
              { topic: 'orders', handler: () => {} },
              { topic: 'frames', handler: () => {}, options: { fanOut: true } },
            ],
          }),
        ],
      });
      await app.start();
      try {
        expect(sdk.subscribe).toHaveBeenCalledTimes(2);
        for (const call of sdk.subscribe.mock.calls)
          expect(call[1]).toEqual({
            autoCompleteMessages: false,
            maxConcurrentCalls: maxConcurrentCalls ?? 1,
          });
      } finally {
        await app.stop();
      }
    },
  );
  it.each([0, -1, 1.5, 1001, NaN, Infinity])(
    'refuses concurrency %s at construction on both arms',
    (maxConcurrentCalls) => {
      const sdk = serviceBusSdk();
      const client = adaptServiceBusModule(sdk.module, {
        connectionString: 'x',
        adminConnectionString: 'x',
      });
      expect(() => resolveServiceBusConcurrency(maxConcurrentCalls)).toThrow(RangeError);
      expect(() => MessagingPlugin({ broker: 'service-bus', client, maxConcurrentCalls })).toThrow(
        RangeError,
      );
      expect(() =>
        MessagingPlugin({ broker: 'service-bus', connectionString: 'x', maxConcurrentCalls }),
      ).toThrow(RangeError);
    },
  );
});
