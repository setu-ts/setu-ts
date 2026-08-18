import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { InMemoryBroker } from '../../../src/brokers/in-memory-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

describe('InMemoryBroker health (M70c)', () => {
  function makeBroker() {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    return new InMemoryBroker(runtime, serializer);
  }

  it('reports down (unreachable) before connect', async () => {
    const broker = makeBroker();
    expect(broker.isReady()).toBe(false);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('reports up (reachable) while connected', async () => {
    const broker = makeBroker();
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports down after disconnect', async () => {
    const broker = makeBroker();
    await broker.connect();
    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });
});
