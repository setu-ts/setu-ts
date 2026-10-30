import { describe, expect, it } from 'vitest';

import {
  ipv4ToNumber,
  normalizeIp,
  parseClientAddress,
  parseIpLiteral,
} from '../../src/middleware/normalize-ip.ts';

// One table pins both the literal grammar and the port-tolerant entry grammar.
const addressCases: readonly (readonly [string, string | null, string | null])[] = [
  ['1.2.3.4', '1.2.3.4', '1.2.3.4'],
  ['0.0.0.0', '0.0.0.0', '0.0.0.0'],
  ['255.255.255.255', '255.255.255.255', '255.255.255.255'],
  ['01.2.3.4', null, null],
  ['1.2.3.256', null, null],
  ['1.2.3', null, null],
  ['1.2..3', null, null],
  ['1.2.3.4.5', null, null],
  ['1.2.3.0001', null, null],
  ['not-an-ip', null, null],
  ['<script>', null, null],
  ['192.168.0.1/32', null, null],
  ['', null, null],
  [' 1.2.3.4', null, null],
  ['1.2.3.4\n', null, null],
  ['2001:DB8::1', '2001:db8::1', '2001:db8::1'],
  ['2001:DB8:0::1', '2001:db8::1', '2001:db8::1'],
  ['::ffff:192.0.2.1', '192.0.2.1', '192.0.2.1'],
  ['::ffff:c000:201', '192.0.2.1', '192.0.2.1'],
  ['fe80::1%eth0', null, null],
  ['2001:::1', null, null],
  ['::ffff:999.1.1.1', null, null],
  ['g::1', null, null],
  [':', null, null],
  ['1.2.3.4:5678', null, '1.2.3.4'],
  ['1.2.3.4:', null, null],
  ['1.2.3.4:65536', null, null],
  ['1.2.3.4:65535', null, '1.2.3.4'],
  ['1.2.3.4:0', null, '1.2.3.4'],
  ['1.2.3.4:00080', null, '1.2.3.4'],
  ['1.2.3.4:000080', null, null],
  ['1.2.3.4:0x50', null, null],
  ['1.2.3.4:+80', null, null],
  ['1.2.3.4:８０', null, null],
  ['hostname:80', null, null],
  ['[2001:db8::1]:443', null, '2001:db8::1'],
  ['[2001:db8::1]', null, '2001:db8::1'],
  ['[::ffff:192.0.2.1]:443', null, '192.0.2.1'],
  ['[1.2.3.4]', null, null],
  ['[1.2.3.4]:80', null, null],
  ['[2001:db8::1', null, null],
  ['[2001:db8::1]:', null, null],
  ['[2001:db8::1]:65536', null, null],
  ['[2001:db8::1]:_obf', null, null],
  ['[2001:db8::1]extra', null, null],
  ['[g::1]', null, null],
  ['2001:db8::1:443', '2001:db8::1:443', '2001:db8::1:443'],
  ['[::1]@evil/[x', null, null],
];

describe('forwarded address validators', () => {
  for (const [input, literal, client] of addressCases) {
    it(`validates ${JSON.stringify(input)}`, () => {
      expect(parseIpLiteral(input)).toBe(literal);
      expect(parseClientAddress(input)).toBe(client);
    });
  }
});

describe('ipv4ToNumber', () => {
  it('keeps its numeric comparison contract for runtime peers and configured CIDRs', () => {
    for (const [input, expected] of [
      ['1.2.3.4', 0x01020304],
      ['255.255.255.255', 0xffffffff],
      ['1.2.3', null],
      ['1.2..3', null],
      ['1.2.3.0001', null],
      ['1.2.3.x', null],
      ['1.2.3.256', null],
    ] as const) {
      expect(ipv4ToNumber(input), input).toBe(expected);
    }
  });
});

describe('normalizeIp (M119d §3.3)', () => {
  it('unmaps IPv4-mapped IPv6 and canonicalizes other IPv6 forms', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['::ffff:198.51.100.7', '198.51.100.7'],
      ['::FFFF:198.51.100.7', '198.51.100.7'],
      // The hexadecimal-tail and uncompressed spellings of one mapped address
      // are the same identity as the dotted-tail spelling.
      ['::ffff:c633:6407', '198.51.100.7'],
      ['::FFFF:C633:6407', '198.51.100.7'],
      ['0:0:0:0:0:ffff:c633:6407', '198.51.100.7'],
      ['::ffff:0:1', '0.0.0.1'],
      // `::ffff:0:a.b.c.d` (IPv4-translated) and `::a.b.c.d` are not mapped.
      ['::ffff:0:198.51.100.7', '::ffff:0:c633:6407'],
      ['2001:DB8:0:0::1', '2001:db8::1'],
      ['::1', '::1'],
      ['198.51.100.7', '198.51.100.7'],
      ['fe80::1%eth0', 'fe80::1%eth0'],
      ['not-an-ip', 'not-an-ip'],
      // The dotted quad is invalid, so the URL parser refuses it: the value
      // stays as written.
      ['::ffff:999.1.1.1', '::ffff:999.1.1.1'],
      // Attacker-written entries with URL syntax never reach the URL parser, so
      // they cannot be rewritten into some other host or address.
      ['::1]@evil.example/[x', '::1]@evil.example/[x'],
      ['::1]:80', '::1]:80'],
      [`${'1:'.repeat(30)}1`, `${'1:'.repeat(30)}1`],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeIp(input), input).toBe(expected);
    }
  });
});
