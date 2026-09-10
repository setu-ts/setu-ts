/**
 * V5-2 regression guard: a management-plane failure must not report the DATA
 * plane as down.
 *
 * `ServiceBusBroker`'s reachability probe reads the namespace's ADMINISTRATION
 * endpoint, which fails independently of the data plane. Before this fix every
 * failure — a network error, and critically the probe's own 2-second bound —
 * resolved `false`, so `/health` reported `down` and `/ready` answered 503 for
 * a broker that was publishing successfully. Measured against the emulator
 * this repository documents, whose administration endpoint has no TLS
 * listener: `0.4.0` answered `up`/`reachable: "unknown"`, `0.5.0` answered
 * `down`/`reachable: false` while `publish` returned 200 in 0.17 s.
 *
 * The timeout case is the one that needs a broker-level test: the adapter
 * classifier never runs for it, because nothing rejects — the probe simply
 * does not settle.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';
import type { IRuntimeServices } from '@setu-ts/common';

/** A runtime whose timers actually fire, so the probe's bound is reachable. */
function createRuntime(): IRuntimeServices {
  return {
    platform: () => 'node',
    uuid: () => 'uuid-1',
    now: () => 1000,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: () => (1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: () => {},
    randomBytes: () => new Uint8Array(16),
    subtle: undefined,
    hostname: 'test',
    version: '0.1.0',
    // Advanced past the probe TTL on each read so no call is served from cache.
    hrtime: (() => {
      let t = 0;
      return () => (t += 60_000);
    })(),
    fs: undefined,
    env: {},
    exit: () => {},
  } as unknown as IRuntimeServices;
}

function brokerWith(isHealthy: IServiceBusTransport['isHealthy']): ServiceBusBroker {
  const transport = {
    send: () => Promise.resolve(),
    open: () => Promise.resolve({ close: () => Promise.resolve() }),
    createSubscription: () => Promise.resolve(),
    deleteSubscription: () => Promise.resolve(),
    close: () => Promise.resolve(),
    isHealthy,
  } as unknown as IServiceBusTransport;
  return new ServiceBusBroker(createRuntime(), {
    serialize: (v: unknown) => JSON.stringify(v),
    deserialize: (s: string) => JSON.parse(s),
  }, { client: transport });
}

describe('service-bus reachability is tri-state (V5-2)', () => {
  it('reports `unknown`, not `down`, when the probe exceeds its bound', async () => {
    // The emulator case: the administration call takes ~5.8 s against a
    // 2 s bound, so the probe never settles and the bound decides. It used to
    // decide `false`.
    const broker = brokerWith(() => new Promise<boolean>(() => {}));
    await broker.connect();

    expect(await broker.reachability()).toBeUndefined();
    // The consequence that matters: /ready must not drain a replica whose
    // data plane is fine.
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports `unknown` when the probe rejects without reaching the namespace', async () => {
    const broker = brokerWith(() => Promise.reject(new Error('ECONNRESET')));
    await broker.connect();

    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true);
  });

  it('still reports `down` when the namespace positively answers unhealthy', async () => {
    // The half of X28-5 that must survive: a definite answer is still a fact
    // about the namespace, and it still drains the replica.
    const broker = brokerWith(() => Promise.resolve(false));
    await broker.connect();

    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('still reports `up` when the namespace answers', async () => {
    const broker = brokerWith(() => Promise.resolve(true));
    await broker.connect();

    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });
});
