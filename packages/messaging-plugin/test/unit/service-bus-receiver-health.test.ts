import { describe, expect, it, vi } from 'vitest';
import { serviceBusFaults } from '../fixtures/service-bus-errors.ts';
import { ServiceBusBroker, adaptServiceBusModule } from '../../src/index.ts';
import type { IServiceBusTransport } from '../../src/index.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { serviceBusSdk } from '../fixtures/service-bus-sdk.ts';
import { flushCloud } from '../fixtures/cloud-transports.ts';

describe('Service Bus receiver health', () => {
  it('fences reply-inbox callbacks across disconnect and reconnect', async () => {
    const sdk = serviceBusSdk();
    const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: adaptServiceBusModule(sdk.module, {
        connectionString: 'x',
        adminConnectionString: 'x',
      }),
    });
    await broker.connect();
    const reply = broker.request('orders', {}).catch((error: unknown) => error);
    await flushCloud();
    const retired = sdk.subscribe.mock.calls[0]![0];
    await broker.disconnect();
    await reply;
    await broker.connect();
    await retired.processError({
      error: new Error('socket'),
      errorSource: 'receive',
      entityPath: 'orders',
      fullyQualifiedNamespace: 'x',
      identifier: 'x',
    });
    await retired.processMessage({ body: '{}' });
    expect(await broker.reachability()).toBeUndefined();
    await broker.disconnect();
  });
  it.each(['receive', 'complete', 'renewLock'] as const)(
    'records only receive outages: %s',
    async (source) => {
      const sdk = serviceBusSdk();
      const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
        client: adaptServiceBusModule(sdk.module, {
          connectionString: 'x',
          adminConnectionString: 'x',
        }),
      });
      await broker.connect();
      await broker.subscribe('orders', () => {});
      const handlers = sdk.subscribe.mock.calls[0]![0];
      for (const { error, outage, aggregateOutage } of serviceBusFaults) {
        for (const { failure, expectedOutage } of [
          { failure: error, expectedOutage: outage },
          {
            failure: new AggregateError([new Error('socket'), error]),
            expectedOutage: aggregateOutage,
          },
        ]) {
          await handlers.processMessage({ body: '{}' });
          await handlers.processError({
            error: failure,
            errorSource: source,
            entityPath: 'orders',
            fullyQualifiedNamespace: 'x',
            identifier: 'x',
          });
          expect(await broker.reachability()).toBe(
            expectedOutage && source === 'receive' ? false : true,
          );
        }
      }
      await handlers.processMessage({ body: '{}' });
      expect(await broker.reachability()).toBe(true);
      await broker.disconnect();
    },
  );
  it('ignores stale receiver errors after unsubscribe', async () => {
    let receive: Parameters<IServiceBusTransport['open']>[3];
    const transport: IServiceBusTransport = {
      send: async () => {},
      open: (_t, _s, _cb, options) => {
        receive = options;
        return Promise.resolve({ close: async () => {} });
      },
      createSubscription: async () => {},
      deleteSubscription: async () => {},
      close: async () => {},
    };
    const broker = new ServiceBusBroker(clockRuntime().runtime, new JsonSerializer(), {
      client: transport,
    });
    await broker.connect();
    const sub = await broker.subscribe('orders', vi.fn());
    await sub.unsubscribe();
    receive?.onReceiveError?.(new Error('socket'), 'receive');
    expect(await broker.reachability()).toBeUndefined();
    await broker.disconnect();
  });
});
