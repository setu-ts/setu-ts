/**
 * Unit tests for option resolution.
 *
 * The meaningful-falsy cases are what these pin: `cacheTtlMs: 0` and
 * `ejection: false` are deliberate configurations that a `??` default would
 * silently swallow.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { resolveOptions } from '../../src/options.ts';

describe('resolveOptions', () => {
  it('applies every documented default', () => {
    const resolved = resolveOptions({ provider: 'static', services: {} });
    expect(resolved.cacheTtlMs).toBe(30_000);
    expect(resolved.strategy).toBe('round-robin');
    expect(resolved.watchIntervalMs).toBe(30_000);
    expect(resolved.waitSeconds).toBe(30);
    expect(resolved.ejection).toEqual({
      failureThreshold: 5,
      windowMs: 30_000,
      durationMs: 30_000,
      maxEjectionPercent: 50,
    });
    expect(resolved.selfRegistration).toBeUndefined();
  });

  it('keeps an explicit cacheTtlMs of 0 rather than defaulting it', () => {
    const resolved = resolveOptions({ provider: 'static', services: {}, cacheTtlMs: 0 });
    expect(resolved.cacheTtlMs).toBe(0);
  });

  it('keeps ejection: false rather than merging defaults into it', () => {
    const resolved = resolveOptions({ provider: 'static', services: {}, ejection: false });
    expect(resolved.ejection).toBe(false);
  });

  it('merges partial ejection options over the defaults', () => {
    const resolved = resolveOptions({
      provider: 'static',
      services: {},
      ejection: { failureThreshold: 2 },
    });
    expect(resolved.ejection).toEqual({
      failureThreshold: 2,
      windowMs: 30_000,
      durationMs: 30_000,
      maxEjectionPercent: 50,
    });
  });

  it('honours an explicit strategy and watch interval', () => {
    const resolved = resolveOptions({
      provider: 'static',
      services: {},
      strategy: 'weighted-random',
      watchIntervalMs: 5_000,
    });
    expect(resolved.strategy).toBe('weighted-random');
    expect(resolved.watchIntervalMs).toBe(5_000);
  });

  it("clamps waitSeconds to Consul's documented maximum of 600", () => {
    const resolved = resolveOptions({
      provider: 'consul',
      address: 'http://consul:8500',
      waitSeconds: 9_000,
    });
    expect(resolved.waitSeconds).toBe(600);
  });

  it('keeps a waitSeconds below the maximum', () => {
    const resolved = resolveOptions({
      provider: 'consul',
      address: 'http://consul:8500',
      waitSeconds: 45,
    });
    expect(resolved.waitSeconds).toBe(45);
  });

  it('fills in the default check and drain delay for selfRegistration', () => {
    const resolved = resolveOptions({
      provider: 'consul',
      address: 'http://consul:8500',
      selfRegistration: { serviceName: 'orders', address: '10.0.0.7', port: 3000 },
    });
    expect(resolved.selfRegistration?.check).toEqual({
      httpPath: '/health',
      intervalSeconds: 10,
      deregisterAfterSeconds: 60,
    });
    expect(resolved.selfRegistration?.drainDelayMs).toBe(0);
  });

  it('uses an explicit check and drain delay verbatim', () => {
    const check = { httpPath: '/ready', intervalSeconds: 3, deregisterAfterSeconds: 30 };
    const resolved = resolveOptions({
      provider: 'consul',
      address: 'http://consul:8500',
      selfRegistration: {
        serviceName: 'orders',
        address: '10.0.0.7',
        port: 3000,
        check,
        drainDelayMs: 5_000,
      },
    });
    expect(resolved.selfRegistration?.check).toEqual(check);
    expect(resolved.selfRegistration?.drainDelayMs).toBe(5_000);
  });

  it('leaves waitSeconds at the default for a non-consul arm', () => {
    const resolved = resolveOptions({ provider: 'dns', mode: 'srv' });
    expect(resolved.waitSeconds).toBe(30);
  });
});
