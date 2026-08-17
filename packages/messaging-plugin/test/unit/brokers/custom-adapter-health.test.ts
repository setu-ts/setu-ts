import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { asBrokerAdapter } from '../../../src/brokers/custom-adapter.ts';

function minimalBroker(overrides: Record<string, unknown> = {}): IMessageBroker {
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    request: () => Promise.resolve(null as never),
    respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    ...overrides,
  };
}

describe('asBrokerAdapter health (M70c)', () => {
  it('delegates reachability to the wrapped isHealthy when present (true)', async () => {
    const adapter = asBrokerAdapter(minimalBroker({ isHealthy: () => Promise.resolve(true) }));
    await adapter.connect();
    expect(await adapter.reachability()).toBe(true);
    const isHealthy = adapter.isHealthy;
    expect(typeof isHealthy).toBe('function');
    if (typeof isHealthy === 'function') {
      expect(await isHealthy()).toBe(true);
    }
  });

  it('delegates reachability to the wrapped isHealthy when present (false)', async () => {
    const adapter = asBrokerAdapter(minimalBroker({ isHealthy: () => Promise.resolve(false) }));
    await adapter.connect();
    expect(await adapter.reachability()).toBe(false);
    const isHealthy = adapter.isHealthy;
    expect(typeof isHealthy).toBe('function');
    if (typeof isHealthy === 'function') {
      expect(await isHealthy()).toBe(false);
    }
  });

  it('reports unknown reachability when the wrapped instance cannot probe', async () => {
    const adapter = asBrokerAdapter(minimalBroker());
    await adapter.connect();
    expect(await adapter.reachability()).toBeUndefined();
    // Unknown is not "known down": the boolean port member reports true.
    const isHealthy = adapter.isHealthy;
    expect(typeof isHealthy).toBe('function');
    if (typeof isHealthy === 'function') {
      expect(await isHealthy()).toBe(true);
    }
  });

  it('reports down (not started) before connect via isReady', async () => {
    const adapter = asBrokerAdapter(minimalBroker());
    expect(adapter.isReady()).toBe(false);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });
});
