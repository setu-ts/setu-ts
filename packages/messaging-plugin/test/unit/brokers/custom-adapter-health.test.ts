import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, ISubscription } from '@setu-ts/common';
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

/**
 * A custom broker whose `isHealthy`/`isReady` READ INSTANCE STATE — the shape
 * the detached-reference defect could not survive: invoking the captured
 * member without its owner throws a bare `TypeError`, which the concurrent
 * health service converts to `{ status: 'down', reason: 'error' }` — a
 * healthy broker reading down on every poll.
 */
class BrokerWithStatefulProbe implements IMessageBroker {
  #reachable = true;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  publish(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): Promise<ISubscription> {
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  }
  request<TRes>(): Promise<TRes> {
    return Promise.resolve(null as never);
  }
  respond(): Promise<ISubscription> {
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  }
  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.#reachable);
  }
  isReady(): boolean {
    return this.#reachable;
  }
  setReachable(value: boolean): void {
    this.#reachable = value;
  }
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

describe('asBrokerAdapter health — stateful custom broker (detached-probe fix)', () => {
  it('delegates through the OWNER: a stateful healthy broker reads reachable/ready, not down', async () => {
    const broker = new BrokerWithStatefulProbe();
    const adapter = asBrokerAdapter(broker);
    await adapter.connect();
    // A detached call throws a bare `TypeError` (private state read off
    // `undefined`); invoking through the owner resolves the live state.
    await expect(adapter.reachability()).resolves.toBe(true);
    expect(adapter.isReady()).toBe(true);
    const isHealthy = adapter.isHealthy;
    expect(typeof isHealthy).toBe('function');
    if (typeof isHealthy === 'function') {
      await expect(isHealthy()).resolves.toBe(true);
    }
  });

  it('retains the live broker state: a later outage is reported, not cached', async () => {
    const broker = new BrokerWithStatefulProbe();
    const adapter = asBrokerAdapter(broker);
    await adapter.connect();
    await expect(adapter.reachability()).resolves.toBe(true);
    broker.setReachable(false);
    await expect(adapter.reachability()).resolves.toBe(false);
    expect(adapter.isReady()).toBe(false);
  });
});
