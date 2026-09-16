import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function makeTransport(options?: {
  isHealthy?: () => Promise<boolean | undefined>;
  send?: (topic: string, body: string) => Promise<void>;
}): IServiceBusTransport {
  const transport: Record<string, unknown> = {
    send: options?.send ?? (async () => {}),
    open: () => Promise.resolve({ close: () => Promise.resolve() }),
    createSubscription: async () => {},
    deleteSubscription: async () => {},
    close: async () => {},
  };
  if (options?.isHealthy !== undefined) {
    transport.isHealthy = options.isHealthy;
  }
  return transport as unknown as IServiceBusTransport;
}

/**
 * Runtime with a MANUALLY advanced monotonic clock, so evidence-window
 * expiry is driven by the test rather than the wall clock.
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

describe('ServiceBusBroker data-plane evidence window (M95b §3.2)', () => {
  it('the C1 proof: a status-less probe failure leaves isReady() true and reachability() undefined', async () => {
    // The gate the v0.6.0 notes claimed does not exist: `isReady()` is
    // lifecycle state, so a namespace whose probe failed at the network
    // layer reads ready AND unknown — the exact shape the evidence window
    // exists to correct.
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({ isHealthy: () => Promise.reject(new Error('socket hung up')) }),
    });
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true);
  });

  it('a publish failure with no statusCode makes reachability() false while the management probe stays undefined', async () => {
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({
        // The emulator shape: the management probe never establishes a fact.
        isHealthy: () => Promise.resolve(undefined),
        send: () => Promise.reject(new Error('connection reset by peer')),
      }),
    });
    await broker.connect();
    await expect(broker.publish('orders', { id: 1 })).rejects.toThrow('connection reset by peer');
    // The recorded failure IS a fact about the data plane.
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('a publish failure WITH a statusCode leaves reachability() untouched', async () => {
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({
        isHealthy: () => Promise.resolve(undefined),
        send: () =>
          Promise.reject(Object.assign(new Error('MessagingEntityNotFound'), { statusCode: 404 })),
      }),
    });
    await broker.connect();
    await expect(broker.publish('orders', { id: 1 })).rejects.toThrow('MessagingEntityNotFound');
    // A deleted topic is an application-level fact, not a network outage:
    // no evidence recorded, so the management probe answers.
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true);
  });

  it('a successful publish resolves true', async () => {
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({ isHealthy: () => Promise.resolve(undefined) }),
    });
    await broker.connect();
    await broker.publish('orders', { id: 1 });
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('past the window the management probe answers again', async () => {
    const manual = createManualRuntime();
    let probes = 0;
    const broker = new ServiceBusBroker(manual.runtime, new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      dataPlaneEvidenceMs: 10,
      client: makeTransport({
        isHealthy: () => {
          probes++;
          return Promise.resolve(undefined);
        },
      }),
    });
    await broker.connect();
    await broker.publish('orders', { id: 1 });
    // Evidence answers; the probe never runs.
    expect(await broker.reachability()).toBe(true);
    expect(probes).toBe(0);

    // age strictly within the window: authoritative (the same half-open
    // interval the management probe's TTL uses, so both signals age on one
    // convention — cleanup B).
    manual.advance(9);
    expect(await broker.reachability()).toBe(true);
    expect(probes).toBe(0);

    // age === window: expired, the probe owns the answer again.
    manual.advance(1);
    expect(await broker.reachability()).toBeUndefined();
    expect(probes).toBe(1);
  });

  it('a rejection thrown BEFORE the transport is never recorded as evidence', async () => {
    // Narrowed by origin: a serialization bug says nothing about the network
    // and must never mark the broker down.
    const broker = new ServiceBusBroker(createFakeRuntime(), {
      serialize: (_message: unknown): string => {
        throw new Error('serialization bug');
      },
      deserialize: (payload: string) => JSON.parse(payload),
    }, {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({ isHealthy: () => Promise.resolve(undefined) }),
    });
    await broker.connect();
    await expect(broker.publish('orders', { id: 1 })).rejects.toThrow('serialization bug');
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true);
  });

  it('a non-object rejection still counts as network-layer evidence', async () => {
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({
        isHealthy: () => Promise.resolve(undefined),
        send: () => Promise.reject('boom'),
      }),
    });
    await broker.connect();
    await expect(broker.publish('orders', { id: 1 })).rejects.toBe('boom');
    expect(await broker.reachability()).toBe(false);
  });

  it('a publish rejected by the not-connected guard records nothing', async () => {
    const transport = makeTransport({ isHealthy: () => Promise.resolve(undefined) });
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: transport,
    });
    await expect(broker.publish('orders', { id: 1 })).rejects.toThrow('not connected');
    await broker.connect();
    // The guard rejection happened before any transport existed and left no
    // evidence behind.
    expect(await broker.reachability()).toBeUndefined();
  });

  it('disconnect() drops the evidence window with the probe', async () => {
    const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport({ isHealthy: () => Promise.resolve(undefined) }),
    });
    await broker.connect();
    await broker.publish('orders', { id: 1 });
    expect(await broker.reachability()).toBe(true);
    await broker.disconnect();
    // Never the stale `true` for a closed client.
    expect(await broker.reachability()).toBeUndefined();
  });
});

describe('dataPlaneEvidenceMs is validated at construction (M95b review)', () => {
  const make = (evidenceMs: number): ServiceBusBroker =>
    new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport(),
      dataPlaneEvidenceMs: evidenceMs,
    });

  it('refuses NaN, which would freeze the window so evidence never ages out', () => {
    // `Number(env.DATA_PLANE_EVIDENCE_MS)` for an unset variable is exactly
    // NaN, and `elapsed >= NaN` is always false — one publish at boot would
    // pin `reachability()` at its outcome indefinitely, which is the
    // fail-open shape this broker exists to close.
    expect(() => make(Number.NaN)).toThrow('dataPlaneEvidenceMs must be a positive integer');
  });

  it('refuses 0 and negative, which would disable the window entirely', () => {
    // Discarding every outcome instantly makes `reachability()` always fall
    // through to the management probe — the pre-M95b behaviour. The option
    // deliberately has no disable arm.
    expect(() => make(0)).toThrow('there is no value that disables');
    expect(() => make(-1)).toThrow('dataPlaneEvidenceMs must be a positive integer');
  });

  it('refuses Infinity and a fractional value', () => {
    expect(() => make(Number.POSITIVE_INFINITY)).toThrow('must be a positive integer');
    expect(() => make(1.5)).toThrow('must be a positive integer');
  });

  it('accepts a positive integer, and omitting it takes the 5s default', async () => {
    const custom = make(10);
    await custom.connect();
    await custom.publish('t', { a: 1 });
    expect(await custom.reachability()).toBe(true);

    const defaulted = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
      connectionString: 'Endpoint=sb://test/',
      client: makeTransport(),
    });
    await defaulted.connect();
    await defaulted.publish('t', { a: 1 });
    expect(await defaulted.reachability()).toBe(true);
  });
});
