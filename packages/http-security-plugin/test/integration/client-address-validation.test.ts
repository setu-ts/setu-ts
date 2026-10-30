import { describe, expect, it } from 'vitest';
import { CLIENT_IP_STATE_KEY, requestOriginOf } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HttpSecurityPlugin } from '../../src/index.ts';
import type { IpSecurityOptions } from '../../src/index.ts';

interface IAddressCase {
  readonly name: string;
  readonly options: IpSecurityOptions;
  readonly header: string;
  readonly expected: string | undefined;
  readonly peer?: string;
  readonly origin?: string;
}

const cases: IAddressCase[] = [];
for (const ipHeader of ['x-forwarded-for', 'x-client-ip']) {
  const options = { trustProxy: true, ipHeader };
  for (const [header, expected] of [
    ['not-an-ip', undefined],
    ['<script>', undefined],
    ['192.168.0.1/32', undefined],
    ['1.2.3.4, 5.6.7.8', '1.2.3.4'],
    ['1.2.3.4:5678', '1.2.3.4'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['1.2.3.4, not-an-ip', '1.2.3.4'],
  ] as const) {
    cases.push({ name: `${ipHeader} leftmost ${header}`, options, header, expected });
  }
  for (const [proxyHops, header, expected] of [
    [0, '1.2.3.4, not-an-ip', undefined],
    [0, 'not-an-ip, 1.2.3.4:5678', '1.2.3.4'],
    [1, 'not-an-ip, 10.0.0.2', undefined],
    [1, '203.0.113.9, not-an-ip', undefined],
    [1, 'not-an-ip, 203.0.113.9, 10.0.0.2', '203.0.113.9'],
    [1, '[2001:DB8::1]:443, 10.0.0.2:80', '2001:db8::1'],
  ] as const) {
    cases.push({
      name: `${ipHeader} proxyHops ${proxyHops} ${header}`,
      options: { ...options, proxyHops },
      header,
      expected,
    });
  }
  for (const [header, expected] of [
    ['not-an-ip, 10.0.0.2', undefined],
    ['not-an-ip, 203.0.113.9, 10.0.0.2', '203.0.113.9'],
    ['203.0.113.9, not-an-ip, 10.0.0.2', undefined],
    ['[2001:DB8::1]:443, 10.0.0.2:80', '2001:db8::1'],
    ['::ffff:192.0.2.1, [::ffff:10.0.0.2]:80', '192.0.2.1'],
  ] as const) {
    cases.push({
      name: `${ipHeader} trusted walk ${header}`,
      options: { ...options, trustedProxies: ['10.0.0.0/8'] },
      header,
      expected,
      peer: '10.0.0.3',
    });
  }
}
cases.push(
  {
    name: 'failed trusted walk keeps the URL origin',
    options: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] },
    header: 'not-an-ip, 10.0.0.2',
    expected: undefined,
    peer: '10.0.0.3',
    origin: 'http://internal:8080',
  },
  {
    name: 'invalid header cannot erase an untrusted runtime peer',
    options: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] },
    header: 'not-an-ip',
    expected: 'runtime-peer',
    peer: 'runtime-peer',
  },
  {
    name: 'socket peer keeps its normalized comparison without address validation',
    options: { trustProxy: true, trustedProxies: ['runtime-peer'] },
    header: '192.0.2.1',
    expected: '192.0.2.1',
    peer: 'runtime-peer',
  },
);

describe('client address validation through a kernel application', () => {
  for (const row of cases) {
    it(row.name, async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), HttpSecurityPlugin({ ipSecurity: row.options })],
      });
      let published: unknown;
      let hasClientKey = false;
      app.router.get('/', (ctx) => {
        published = ctx.state.get(CLIENT_IP_STATE_KEY);
        hasClientKey = ctx.state.has(CLIENT_IP_STATE_KEY);
        return ctx.response.text(requestOriginOf(ctx).origin);
      });
      await app.start();
      try {
        const response = await app.inject({
          method: 'GET',
          url: 'http://internal:8080/',
          headers: {
            [row.options.ipHeader ?? 'x-forwarded-for']: row.header,
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'public.example',
          },
          ...(row.peer === undefined ? {} : { ip: row.peer }),
        });
        expect(response.statusCode).toBe(200);
        expect(hasClientKey).toBe(true);
        expect(published).toBe(row.expected);
        if (row.origin !== undefined) expect(response.body).toBe(row.origin);
      } finally {
        await app.stop();
      }
    });
  }
});
