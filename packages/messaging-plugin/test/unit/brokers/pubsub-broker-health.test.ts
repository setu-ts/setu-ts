import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPubSubTransport } from '../../../src/brokers/pubsub-broker.ts';
import { GcpPubSubBroker } from '../../../src/brokers/pubsub-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

function makeTransport(isHealthy?: () => Promise<boolean>): IPubSubTransport {
  const transport: Record<string, unknown> = {
    publish: async () => {},
    open: () => Promise.resolve({ close: () => Promise.resolve() }),
    createSubscription: async () => {},
    deleteSubscription: async () => {},
    close: async () => {},
  };
  if (isHealthy !== undefined) {
    transport.isHealthy = isHealthy;
  }
  return transport as unknown as IPubSubTransport;
}

function makeBroker(transport: IPubSubTransport) {
  const runtime = createFakeRuntime();
  return new GcpPubSubBroker(runtime, new JsonSerializer(), {
    projectId: 'test-project',
    client: transport,
  });
}

describe('GcpPubSubBroker health (M70c)', () => {
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
