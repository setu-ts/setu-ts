import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IServiceBusTransport } from '../../../src/brokers/service-bus-broker.ts';
import { ServiceBusBroker } from '../../../src/brokers/service-bus-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

function makeTransport(isHealthy?: () => Promise<boolean>): IServiceBusTransport {
  const transport: Record<string, unknown> = {
    send: async () => {},
    open: () => Promise.resolve({ close: () => Promise.resolve() }),
    createSubscription: async () => {},
    deleteSubscription: async () => {},
    close: async () => {},
  };
  if (isHealthy !== undefined) {
    transport.isHealthy = isHealthy;
  }
  return transport as unknown as IServiceBusTransport;
}

function makeBroker(transport: IServiceBusTransport) {
  const runtime = createFakeRuntime();
  return new ServiceBusBroker(runtime, new JsonSerializer(), {
    connectionString: 'Endpoint=sb://test.servicebus.windows.net/',
    client: transport,
  });
}

describe('ServiceBusBroker health (M70c)', () => {
  it('reports down (not started) before connect', async () => {
    const broker = makeBroker(makeTransport(() => Promise.resolve(true)));
    expect(broker.isReady()).toBe(false);
    expect(await broker.reachability()).toBeUndefined();
  });

  it('reports up when the transport is healthy', async () => {
    const broker = makeBroker(makeTransport(() => Promise.resolve(true)));
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports down when the transport is unhealthy', async () => {
    const broker = makeBroker(makeTransport(() => Promise.resolve(false)));
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('reports unknown when the transport has no isHealthy', async () => {
    const broker = makeBroker(makeTransport());
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });
});
