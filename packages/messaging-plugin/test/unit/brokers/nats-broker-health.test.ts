import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { INatsConnection } from '../../../src/interfaces/index.ts';
import { NatsBroker } from '../../../src/brokers/nats-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

interface FakeNats {
  client: INatsConnection;
  /** Fires the registered `Disconnect`/`Reconnect` listeners. */
  fire: (event: string) => void;
}

/**
 * Minimal NATS facade satisfying `validateClient` (jetstream/jetstreamManager/
 * close) plus a configurable liveness surface and an event emitter.
 */
function makeNats(opts: {
  isClosed?: () => boolean;
  rtt?: () => Promise<number>;
  events?: boolean;
} = {}): FakeNats {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const client: Record<string, unknown> = {
    jetstream: () => ({}),
    jetstreamManager: () =>
      Promise.resolve({
        streams: {
          info: () => Promise.resolve({}),
          add: () => Promise.resolve({}),
        },
      }),
    close: () => {},
  };
  if (opts.isClosed !== undefined) {
    client.isClosed = opts.isClosed;
  }
  if (opts.rtt !== undefined) {
    client.rtt = opts.rtt;
  }
  if (opts.events !== false) {
    client.on = (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    };
    client.off = (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(listener);
      if (idx !== -1) {
        arr.splice(idx, 1);
      }
    };
  }
  return {
    client: client as unknown as INatsConnection,
    fire: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

function makeBroker(client: INatsConnection) {
  const runtime = createFakeRuntime();
  return new NatsBroker(runtime, new JsonSerializer(), {
    client,
    url: 'nats://localhost:4222',
  });
}

describe('NatsBroker health (M70c)', () => {
  it('reports down before connect', async () => {
    const { client } = makeNats();
    const broker = makeBroker(client);
    expect(broker.isReady()).toBe(false);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });

  it('reports up when not closed and rtt resolves', async () => {
    const { client } = makeNats({
      isClosed: () => false,
      rtt: () => Promise.resolve(5),
    });
    const broker = makeBroker(client);
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports down when the connection reports closed', async () => {
    const { client } = makeNats({
      isClosed: () => true,
      rtt: () => Promise.resolve(5),
    });
    const broker = makeBroker(client);
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('reports down during a Disconnect fault window, up after Reconnect', async () => {
    const { client, fire } = makeNats({
      isClosed: () => false,
      rtt: () => Promise.resolve(5),
    });
    const broker = makeBroker(client);
    await broker.connect();
    // Baseline: healthy.
    expect(await broker.reachability()).toBe(true);
    // A Disconnect event opens the fault window: isHealthy false, isReady true.
    fire('Disconnect');
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
    // Reconnect closes the window.
    fire('Reconnect');
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('refuses an injected client that fails the structural shape check', async () => {
    // M70c review: the validation throw was reachable and untested, so a
    // malformed injected client would have surfaced later as a bare TypeError
    // rather than at connect() with a message naming the missing members.
    const broker = makeBroker({ close: () => {} } as unknown as INatsConnection);
    await expect(broker.connect()).rejects.toThrow(
      'Injected NATS client does not match the required structural shape',
    );
  });

  it('removes its event listeners on disconnect', async () => {
    // The disposer returned by #attachEvent was never driven, so a listener
    // leak across connect/disconnect cycles would not have been caught — the
    // accumulation class M47 fixed in resilience-plugin.
    const removed: string[] = [];
    const { client } = makeNats({ isClosed: () => false, rtt: () => Promise.resolve(1) });
    const withTracking = client as unknown as Record<string, unknown>;
    const originalOff = withTracking.off as (e: string, l: unknown) => void;
    withTracking.off = (event: string, listener: unknown) => {
      removed.push(event);
      originalOff(event, listener);
    };

    const broker = makeBroker(client);
    await broker.connect();
    await broker.disconnect();

    expect(removed).toContain('Disconnect');
    expect(removed).toContain('Reconnect');
  });

  it('reports unknown when the client lacks liveness members', async () => {
    const { client } = makeNats();
    const broker = makeBroker(client);
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });
});
