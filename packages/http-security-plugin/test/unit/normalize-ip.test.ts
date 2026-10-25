import { describe, expect, it } from 'vitest';

import { normalizeIp } from '../../src/middleware/normalize-ip.ts';

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
