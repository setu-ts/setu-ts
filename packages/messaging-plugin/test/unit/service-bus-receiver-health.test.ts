import { describe, expect, it, vi } from 'vitest';
import { serviceBusFaults } from '../fixtures/service-bus-errors.ts';
import { ServiceBusBroker, adaptServiceBusModule } from '../../src/index.ts';
import type { IServiceBusTransport } from '../../src/index.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { serviceBusSdk } from '../fixtures/service-bus-sdk.ts';
import { flushCloud, serviceBusTransport } from '../fixtures/cloud-transports.ts';

describe('Service Bus receiver health', () => {
  it('runs an application delivery while disconnect drains, without recording evidence', async () => {
    const clock = clockRuntime();
    const sdk = serviceBusSdk();
    const closeEntered = Promise.withResolvers<void>();
    const closeGate = Promise.withResolvers<void>();
    sdk.subscribe.mockImplementationOnce(() => ({
      close: () => {
        closeEntered.resolve();
        return closeGate.promise;
      },
    }));
    const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
      client: adaptServiceBusModule(sdk.module, {
        connectionString: 'x',
        adminConnectionString: 'x',
      }),
    });
    await broker.connect();
    const request = broker.request('orders', {}).catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    try {
      await flushCloud();
      const handler = vi.fn();
      await broker.subscribe('events', handler);
      const application = sdk.subscribe.mock.calls[1]![0];
      sdk.sendMessages.mockRejectedValueOnce(new Error('socket'));
      await expect(broker.publish('orders', {})).rejects.toMatchObject({
        name: 'BackendOutcomeUnknownError',
      });
      expect(await broker.reachability()).toBe(false);
      closing = broker.disconnect();
      await closeEntered.promise;
      await application.processMessage({ body: '{}' });
      expect(await broker.reachability()).toBe(false);
      // Settled normally: abandoning here would hand it straight back to this
      // receiver and spend its delivery count on every round.
      expect(handler).toHaveBeenCalledOnce();
      expect(sdk.completeMessage).toHaveBeenCalledOnce();
      expect(sdk.abandonMessage).not.toHaveBeenCalled();
    } finally {
      closeGate.resolve();
      await (closing ?? broker.disconnect());
      await request;
      expect(clock.timerCount()).toBe(0);
    }
  });

  it('acknowledges a handler that finishes while disconnect waits for the reply inbox to close', async () => {
    const clock = clockRuntime();
    const sdk = serviceBusSdk();
    const closeEntered = Promise.withResolvers<void>();
    const closeGate = Promise.withResolvers<void>();
    sdk.subscribe.mockImplementationOnce(() => ({
      close: () => {
        closeEntered.resolve();
        return closeGate.promise;
      },
    }));
    const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
      client: adaptServiceBusModule(sdk.module, {
        connectionString: 'x',
        adminConnectionString: 'x',
      }),
    });
    await broker.connect();
    const request = broker.request('orders', {}).catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    const release = Promise.withResolvers<void>();
    try {
      await flushCloud();
      const handler = vi.fn(() => release.promise);
      await broker.subscribe('events', handler);
      const application = sdk.subscribe.mock.calls[1]![0];
      const delivery = application.processMessage({ body: '{}' });
      await flushCloud();
      expect(handler).toHaveBeenCalledOnce();
      closing = broker.disconnect();
      await closeEntered.promise;
      release.resolve();
      await delivery;
      expect(sdk.completeMessage).toHaveBeenCalledOnce();
      expect(sdk.abandonMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      closeGate.resolve();
      await (closing ?? broker.disconnect());
      await request;
      expect(clock.timerCount()).toBe(0);
    }
  });

  it('settles a retry wait that ends while disconnect waits for the reply inbox to close', async () => {
    const clock = clockRuntime();
    const fake = serviceBusTransport();
    const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
      client: fake.transport,
      consumerRetry: { maxAttempts: 5, delaysMs: [100] },
    });
    await broker.connect();
    const request = broker.request('orders', {}).catch((error: unknown) => error);
    const closeGate = Promise.withResolvers<void>();
    let closing: Promise<void> | undefined;
    try {
      await flushCloud();
      await broker.subscribe('events', () => Promise.reject(new Error('handler')));
      const [inbox, application] = fake.opens;
      inbox!.close.mockReturnValueOnce(closeGate.promise);
      const nack = vi.fn(() => Promise.resolve());
      const delivery = application!.deliver({
        payload: '{}',
        deliveryCount: 0,
        ack: vi.fn(),
        nack,
        deadLetter: vi.fn(),
      });
      await flushCloud();
      closing = broker.disconnect();
      await flushCloud();
      expect(inbox!.close).toHaveBeenCalledOnce();
      // Still waiting on its retry delay, so the settle below is the wait ending.
      expect(nack).not.toHaveBeenCalled();
      await clock.advance(100);
      await delivery;
      expect(nack).toHaveBeenCalledOnce();
    } finally {
      closeGate.resolve();
      await (closing ?? broker.disconnect());
      await request;
    }
  });

  it('finishes disconnect past a reply inbox open that never settles, then closes it when it does', async () => {
    const clock = clockRuntime();
    const fake = serviceBusTransport();
    const warn = vi.fn();
    const broker = new ServiceBusBroker(clock.runtime, new JsonSerializer(), {
      client: fake.transport,
      logger: { error: vi.fn(), warn },
    });
    const hung = Promise.withResolvers<{ close: () => Promise<void> }>();
    const lateClose = vi.fn(() => Promise.resolve());
    vi.mocked(fake.transport.open).mockReturnValueOnce(hung.promise);
    await broker.connect();
    const request = broker.request('orders', {}).catch((error: unknown) => error);
    await flushCloud();
    let done = false;
    const closing = broker.disconnect().then(() => {
      done = true;
    });
    try {
      await clock.advance(4999);
      expect(done).toBe(false);
      await clock.advance(1);
      await closing;
      expect(done).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        'Messaging reply inbox cleanup did not finish within 5000ms; disconnect continues and closes it when it settles',
      );
      expect(fake.transport.close).toHaveBeenCalledOnce();
      hung.resolve({ close: lateClose });
      await flushCloud();
      expect(lateClose).toHaveBeenCalledOnce();
      expect(fake.transport.deleteSubscription).toHaveBeenCalledOnce();
      expect(clock.timerCount()).toBe(0);
    } finally {
      hung.resolve({ close: lateClose });
      await closing;
      await request;
    }
  });

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
