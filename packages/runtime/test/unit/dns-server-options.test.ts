import { describe, expect, it } from 'vitest';
import { parseDnsResolverOptions } from '../../src/adapters/shared/dns-server-options.ts';

describe('DNS server options', () => {
  it.each([
    ['10.0.0.53', '10.0.0.53', 53, 4],
    ['10.0.0.53:5353', '10.0.0.53', 5353, 4],
    ['10.0.0.53:65535', '10.0.0.53', 65535, 4],
    ['10.0.0.53:1', '10.0.0.53', 1, 4],
    ['::1', '::1', 53, 6],
    ['[::1]:5353', '::1', 5353, 6],
    ['::1:5353', '::1:5353', 53, 6],
  ] as const)('accepts %s', (entry, address, port, family) => {
    expect(parseDnsResolverOptions({ servers: [entry], timeoutMs: 10 })).toEqual({
      servers: [{ address, port, family }],
      timeoutMs: 10,
    });
  });
  it.each([
    'dns.local',
    '',
    '10.0.0.53:0',
    '10.0.0.53:65536',
    '10.0.0.53:+53',
    '10.0.0.53: 53',
    ' 10.0.0.53',
    'fe80::1%eth0',
    '[::1%eth0]:53',
    '[::1]',
    '[10.0.0.53]:53',
    '[::1]:-1',
    '300.0.0.1',
    '::g',
  ])('refuses %s with its index and entry', (entry) => {
    const run = () => parseDnsResolverOptions({ servers: ['::1', entry], timeoutMs: 10 });
    expect(run).toThrow(RangeError);
    expect(run).toThrow(`servers[1] '${entry}'`);
    expect(run).toThrow('brackets for IPv6');
  });
  it('refuses an empty list and a non-array at the boundary', () => {
    expect(() => parseDnsResolverOptions({ servers: [], timeoutMs: 0 })).toThrow('servers');
    expect(() => parseDnsResolverOptions({ servers: null as never, timeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => parseDnsResolverOptions({ servers: [null as never], timeoutMs: 0 })).toThrow(
      'servers[0]',
    );
  });
  it.each([
    ['a Symbol', Symbol('dns'), '(symbol)'],
    ['a null-prototype object', Object.create(null) as unknown, '(object)'],
    ['a number', 53, '(number)'],
    ['an undefined entry', undefined, '(undefined)'],
  ])('refuses %s with a RangeError naming its type', (_label, entry, shown) => {
    const run = () => parseDnsResolverOptions({ servers: [entry as never], timeoutMs: 0 });
    expect(run).toThrow(RangeError);
    expect(run).toThrow(`servers[0] ${shown}`);
  });
  it('reads entries by index, not through a replaced iterator', () => {
    const servers = ['not-an-ip'];
    Object.defineProperty(servers, Symbol.iterator, { value: function* () {} });
    expect(() => parseDnsResolverOptions({ servers, timeoutMs: 10 })).toThrow(
      "servers[0] 'not-an-ip'",
    );
  });
  it('reads the server count once', () => {
    let reads = 0;
    const servers = new Proxy(['::1'], {
      get(target, key, receiver) {
        if (key === 'length') return reads++ === 0 ? 1 : 0;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(parseDnsResolverOptions({ servers, timeoutMs: 10 }).servers).toHaveLength(1);
    expect(reads).toBe(1);
  });
  it.each([Number.NaN, -1, 0.5])('refuses a list whose length reads %s', (length) => {
    const servers = new Proxy(['::1'], {
      get(target, key, receiver) {
        return key === 'length' ? length : (Reflect.get(target, key, receiver) as unknown);
      },
    });
    expect(() => parseDnsResolverOptions({ servers, timeoutMs: 10 })).toThrow(
      'servers must be a non-empty array',
    );
  });
  it('returns the timeoutMs it checked', () => {
    let reads = 0;
    const options = {
      servers: ['::1'],
      get timeoutMs() {
        return reads++ === 0 ? 10 : -5;
      },
    };
    expect(parseDnsResolverOptions(options).timeoutMs).toBe(10);
  });
  it('refuses a sparse array at its first hole', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the input under test
    const sparse = [, '1.1.1.1'] as unknown as string[];
    expect(() => parseDnsResolverOptions({ servers: sparse, timeoutMs: 0 })).toThrow(
      'servers[0] (undefined)',
    );
    expect(() => parseDnsResolverOptions({ servers: new Array<string>(1), timeoutMs: 0 })).toThrow(
      RangeError,
    );
  });
  it.each([0, 2_147_483_647])('accepts timeoutMs %s and duplicate servers', (timeoutMs) => {
    const result = parseDnsResolverOptions({ servers: ['::1', '::1'], timeoutMs });
    expect(result.timeoutMs).toBe(timeoutMs);
    expect(result.servers).toHaveLength(2);
  });
  it.each([2_147_483_648, 1.5, -1, NaN, Infinity])('refuses timeoutMs %s', (timeoutMs) => {
    expect(() => parseDnsResolverOptions({ servers: ['::1'], timeoutMs })).toThrow(RangeError);
    expect(() => parseDnsResolverOptions({ servers: ['::1'], timeoutMs })).toThrow('timeoutMs');
  });
});
