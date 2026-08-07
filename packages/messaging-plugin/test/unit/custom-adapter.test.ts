import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { asBrokerAdapter } from '../../src/brokers/custom-adapter.ts';
import type { IMessageBroker } from '@hono-enterprise/common';

describe('asBrokerAdapter', () => {
  function createMinimalBroker(overrides: Record<string, unknown> = {}): IMessageBroker {
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

  it('returns instance unchanged when isReady is present', () => {
    const broker = createMinimalBroker({
      isReady: () => true,
    });
    const adapter = asBrokerAdapter(broker);
    expect(adapter).toBe(broker);
    expect(adapter.isReady()).toBe(true);
  });

  it('wraps instance when isReady is absent', () => {
    const broker = createMinimalBroker();
    const adapter = asBrokerAdapter(broker);
    expect(adapter).not.toBe(broker);
    expect(adapter.isReady()).toBe(false);
  });

  it('reports connected after connect on wrapped instance', async () => {
    let connected = false;
    const broker = createMinimalBroker({
      connect: () => {
        connected = true;
        return Promise.resolve();
      },
    });
    const adapter = asBrokerAdapter(broker);
    await adapter.connect();
    expect(connected).toBe(true);
    expect(adapter.isReady()).toBe(true);
  });

  it('reports disconnected after disconnect on wrapped instance', async () => {
    const broker = createMinimalBroker();
    const adapter = asBrokerAdapter(broker);
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isReady()).toBe(false);
  });

  it('delegates publish to instance', async () => {
    let published = false;
    const broker = createMinimalBroker({
      publish: () => {
        published = true;
        return Promise.resolve();
      },
    });
    const adapter = asBrokerAdapter(broker);
    await adapter.publish('topic', { data: 1 });
    expect(published).toBe(true);
  });

  it('delegates subscribe to instance', async () => {
    let subscribed = false;
    const broker = createMinimalBroker({
      subscribe: () => {
        subscribed = true;
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
    });
    const adapter = asBrokerAdapter(broker);
    await adapter.subscribe('topic', () => {});
    expect(subscribed).toBe(true);
  });

  it('delegates request to instance', async () => {
    let requested = false;
    const broker = createMinimalBroker({
      request: () => {
        requested = true;
        return Promise.resolve({} as never);
      },
    });
    const adapter = asBrokerAdapter(broker);
    await adapter.request('topic', {});
    expect(requested).toBe(true);
  });

  it('delegates respond to instance', async () => {
    let responded = false;
    const broker = createMinimalBroker({
      respond: () => {
        responded = true;
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
    });
    const adapter = asBrokerAdapter(broker);
    await adapter.respond('topic', () => {});
    expect(responded).toBe(true);
  });
});
