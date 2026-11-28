import { describe, expect, it } from 'vitest';
import { ServiceBusBroker, adaptServiceBusModule } from '../../src/index.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { flushCloud } from '../fixtures/cloud-transports.ts';
import { serviceBusSdk } from '../fixtures/service-bus-sdk.ts';

describe('Service Bus reply inbox', () => {
  it('expires after five idle minutes, keeps inbox concurrency at one and deletes on close', async () => {
    const sdk = serviceBusSdk();
    const clock = clockRuntime();
    const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
      client: adaptServiceBusModule(sdk.module, {
        connectionString: 'x',
        adminConnectionString: 'x',
      }),
      maxConcurrentCalls: 4,
    });
    await broker.connect();
    const response = broker.request('orders', {}).catch((error: unknown) => error);
    await flushCloud();
    expect(sdk.createSubscription).toHaveBeenCalledWith(
      'messaging.replies',
      expect.stringMatching(/^rr-inbox-/),
      { autoDeleteOnIdle: 'PT300S' },
    );
    expect(sdk.subscribe.mock.calls[0]![1]).toEqual({ autoCompleteMessages: false });
    expect(sdk.sendMessages.mock.calls[0]).toHaveLength(2);
    await broker.disconnect();
    await response;
    expect(sdk.deleteSubscription).toHaveBeenCalledWith(
      'messaging.replies',
      expect.stringMatching(/^rr-inbox-/),
    );
    expect(clock.timerCount()).toBe(0);
  });
});
