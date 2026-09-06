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

  describe('bounded, cached probe (M90b)', () => {
    /**
     * Runtime with a MANUALLY advanced monotonic clock, so TTL expiry is
     * driven by the test rather than the wall clock.
     */
    function createManualRuntime(): {
      runtime: ReturnType<typeof createFakeRuntime>;
      advance: (ms: number) => void;
    } {
      let clock = 0;
      const base = createFakeRuntime();
      const runtime = {
        ...base,
        hrtime: () => clock,
      } as ReturnType<typeof createFakeRuntime>;
      return { runtime, advance: (ms: number) => void (clock += ms) };
    }

    it('serves repeated reachability calls from the 5s cache', async () => {
      const manual = createManualRuntime();
      let transportProbes = 0;
      const broker = new ServiceBusBroker(manual.runtime, new JsonSerializer(), {
        connectionString: 'Endpoint=sb://test/',
        client: makeTransport(() => {
          transportProbes++;
          return Promise.resolve(true);
        }),
      });
      await broker.connect();

      await broker.reachability();
      await broker.reachability();
      manual.advance(4_999);
      await broker.reachability();
      // All three answered from the one cached outcome.
      expect(transportProbes).toBe(1);

      manual.advance(1); // TTL boundary crossed: 5_000 elapsed.
      await broker.reachability();
      expect(transportProbes).toBe(2);
    });

    it('bounds a hung transport: reachability resolves false after the 2s deadline', async () => {
      const runtime = createFakeRuntime();
      const timers: Array<{ at: number; fn: () => void }> = [];
      let clock = 0;
      const manualRuntime = {
        ...runtime,
        hrtime: () => clock,
        setTimeout: (fn: () => void, ms: number) => {
          timers.push({ at: clock + ms, fn });
          return { id: timers.length };
        },
        clearTimeout: (_handle: unknown) => {},
      } as ReturnType<typeof createFakeRuntime>;

      const broker = new ServiceBusBroker(manualRuntime, new JsonSerializer(), {
        connectionString: 'Endpoint=sb://test/',
        client: makeTransport(() => new Promise(() => {})), // never settles
      });
      await broker.connect();

      const pending = broker.reachability();
      // Fire the deadline timer the probe armed.
      clock = 2_000;
      for (const timer of timers.splice(0)) timer.fn();
      expect(await pending).toBe(false);
      expect(await broker.isHealthy()).toBe(false);
    });

    it('does not report a broker down when a hung transport later answers true', async () => {
      // Two consecutive calls inside the TTL share ONE in-flight probe; the
      // hung transport's eventual answer is not double-counted.
      const runtime = createFakeRuntime();
      let released: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      let probes = 0;
      const broker = new ServiceBusBroker(runtime, new JsonSerializer(), {
        connectionString: 'Endpoint=sb://test/',
        client: makeTransport(() => {
          probes++;
          return gate.then(() => true);
        }),
      });
      await broker.connect();

      const first = broker.reachability();
      const second = broker.reachability();
      released!();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(probes).toBe(1);
    });

    it('drops the cached probe on disconnect: reachability is unknown afterwards', async () => {
      const broker = makeBroker(makeTransport(() => Promise.resolve(true)));
      await broker.connect();
      expect(await broker.reachability()).toBe(true);
      await broker.disconnect();
      // Post-close the broker has no transport to probe: `undefined` ("not
      // known down", M70c) — never the cached stale `true`, and never a
      // fresh probe fired against the closed client.
      expect(await broker.reachability()).toBeUndefined();
      expect(await broker.isHealthy()).toBe(true);
    });
  });
});
