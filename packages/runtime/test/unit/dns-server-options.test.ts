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
