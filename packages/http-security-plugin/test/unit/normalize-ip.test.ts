import { describe, expect, it } from 'vitest';

import { normalizeIp } from '../../src/middleware/normalize-ip.ts';

describe('normalizeIp (M119d §3.3)', () => {
  it('unmaps IPv4-mapped IPv6 and canonicalizes other IPv6 forms', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['::ffff:198.51.100.7', '198.51.100.7'],
      ['::FFFF:198.51.100.7', '198.51.100.7'],
      ['2001:DB8:0:0::1', '2001:db8::1'],
      ['::1', '::1'],
      ['198.51.100.7', '198.51.100.7'],
      ['fe80::1%eth0', 'fe80::1%eth0'],
      ['not-an-ip', 'not-an-ip'],
      // The mapped form matches the regex but the dotted quad is invalid, so
      // the URL path is tried and refuses it: the value stays as written.
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
