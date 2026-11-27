import { ServiceDiscoveryPlugin } from '../../src/plugin/service-discovery-plugin.ts';
/**
 * Unit tests for option resolution.
 *
 * The meaningful-falsy cases are what these pin: `cacheTtlMs: 0` and
 * `ejection: false` are deliberate configurations that a `??` default would
 * silently swallow.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { resolveOptions } from '../../src/options.ts';

describe('DNS servers', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.1:7853',
    '::1',
    '[::1]:53',
    '2001:db8::1',
    '::ffff:192.0.2.1',
    '::1:5353',
  ])('accepts the IP literal %s', (entry) => {
    expect(() =>
      ServiceDiscoveryPlugin({ provider: 'dns', mode: 'srv', servers: [entry] }),
    ).not.toThrow();
  });
  it.each([
    'localhost',
    '127.0.0.1:65536',
    '127.0.0.1:0',
    '',
    '::1:78533',
    '[::1]:0',
    '[::1]:65536',
    '[::1]',
    '[127.0.0.1]:53',
    'fe80::1%eth0',
    '[fe80::1%eth0]:53',
    ' 127.0.0.1',
    '127.01.0.1',
    '256.0.0.1',
    '::ffff:192.00.2.1',
    '1::2::3',
    '[::1]:-1',
    '[::1]:1.5',
    '::g',
  ])('refuses servers entry %s at construction', (entry) => {
    expect(() =>
      ServiceDiscoveryPlugin({ provider: 'dns', mode: 'srv', servers: [entry] }),
    ).toThrow(RangeError);
    expect(() =>
      ServiceDiscoveryPlugin({ provider: 'dns', mode: 'srv', servers: [entry] }),
    ).toThrow(`'${entry}'`);
  });
  it.each([[], new Array<string>(1), [null], '127.0.0.1'])(
    'refuses an empty, sparse or non-string list: %j',
    (servers) => {
      expect(() =>
        ServiceDiscoveryPlugin({
          provider: 'dns',
          mode: 'srv',
          servers: servers as readonly string[],
        }),
      ).toThrow('servers');
    },
  );
});

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

it('defaults the read bound and empty grace, and accepts zero', () => {
  expect(resolveOptions({ provider: 'static', services: {} })).toMatchObject({
    resolveTimeoutMs: 2000,
    emptyAnswerGraceMs: 30000,
  });
  expect(
    resolveOptions({
      provider: 'static',
      services: {},
      resolveTimeoutMs: 0,
      emptyAnswerGraceMs: 0,
    }),
  ).toMatchObject({ resolveTimeoutMs: 0, emptyAnswerGraceMs: 0 });
});
for (const field of ['resolveTimeoutMs', 'emptyAnswerGraceMs', 'cacheTtlMs'] as const) {
  for (const value of [-1, NaN, Infinity, 2147483648]) {
    it(`refuses ${field}=${value} both at the resolver and plugin`, () => {
      const options = { provider: 'static' as const, services: {}, [field]: value };
      expect(() => resolveOptions(options)).toThrow(field);
      expect(() => ServiceDiscoveryPlugin(options)).toThrow(field);
    });
  }
}

it('keeps a valid cacheTtlMs, including 0 and the largest timer value', () => {
  for (const cacheTtlMs of [0, 1, 2147483647]) {
    expect(resolveOptions({ provider: 'static', services: {}, cacheTtlMs }).cacheTtlMs).toBe(
      cacheTtlMs,
    );
  }
});

it('names the cacheTtlMs meaning of 0 in its refusal and never echoes the value', () => {
  let message = '';
  try {
    resolveOptions({ provider: 'static', services: {}, cacheTtlMs: -12345 });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('cacheTtlMs');
  expect(message).not.toContain('12345');
  expect(() =>
    resolveOptions({ provider: 'static', services: {}, cacheTtlMs: Number.NaN }),
  ).toThrow(/0 refreshes on every warm call/);
});
