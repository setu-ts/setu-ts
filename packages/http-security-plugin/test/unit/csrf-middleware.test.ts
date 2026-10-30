/* eslint-disable require-await -- test fixtures use sync methods matching async interface signatures */
import { describe, expect, it } from 'vitest';

import { csrfMiddleware } from '../../src/middleware/csrf-middleware.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';
import { REQUEST_ORIGIN_STATE_KEY } from '@setu-ts/common';

describe('opaque Origin under no-referrer (M119c)', () => {
  for (const origin of [' null', 'null ']) {
    it(`records Web Headers normalization of ${JSON.stringify(origin)} (Headers strips it before the middleware, §8a.1.2)`, async () => {
      const { ctx, response } = createFakeContext({
        request: {
          method: 'POST',
          headers: {
            Origin: origin,
            'Sec-Fetch-Site': 'same-origin',
          },
        },
      });
      expect(ctx.request.headers.get('Origin')).toBe('null');
      let calls = 0;
      await csrfMiddleware()(ctx, () => {
        calls++;
        return Promise.resolve();
      });
      expect(calls).toBe(1);
      expect(response.statuses).toEqual([]);
    });
  }
  const cases = [
    ['null', 'same-origin', true],
    ['null', ' Same-Origin ', true],
    ...[
      'cross-site',
      'same-site',
      'none',
      undefined,
      '',
      'same-origin, cross-site',
      'same-origin, same-origin',
    ].map((site) => ['null', site, false] as const),
    ...[' null', 'NULL', 'null ', '"null"', 'https://foreign.example'].map(
      (origin) => [origin, 'same-origin', false] as const,
    ),
  ] as const;

  for (const [origin, site, allowed] of cases) {
    it(`${JSON.stringify(origin)} / ${JSON.stringify(site)} → ${allowed}`, async () => {
      const { ctx, response } = createFakeContext({ request: { method: 'POST' } });
      // Headers trims HTTP whitespace at construction. Override the read seam
      // to test the exact source-origin bytes the middleware receives as well.
      const original = ctx.request.headers.get.bind(ctx.request.headers);
      ctx.request.headers.get = (name) =>
        name.toLowerCase() === 'origin'
          ? origin
          : name.toLowerCase() === 'sec-fetch-site'
            ? (site ?? null)
            : original(name);
      let calls = 0;
      await csrfMiddleware()(ctx, () => {
        calls++;
        return Promise.resolve();
      });
      expect(calls).toBe(allowed ? 1 : 0);
      expect(response.statuses).toEqual(allowed ? [] : [403]);
    });
  }

  for (const [setting, allowed] of [
    [undefined, true],
    [true, true],
    [false, false],
  ] as const) {
    it(`acceptNullOriginSameOrigin: ${String(setting)} → ${allowed ? 'accepted' : 'refused'}`, async () => {
      const { ctx, response } = createFakeContext({
        request: { method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' } },
      });
      let calls = 0;
      await csrfMiddleware(setting === undefined ? {} : { acceptNullOriginSameOrigin: setting })(
        ctx,
        () => {
          calls++;
          return Promise.resolve();
        },
      );
      expect(calls).toBe(allowed ? 1 : 0);
      expect(response.statuses).toEqual(allowed ? [] : [403]);
    });
  }

  it.each(['false', 0, null, {}])(
    'refuses a non-boolean acceptNullOriginSameOrigin (%j) when built',
    (value) => {
      expect(() =>
        csrfMiddleware({ acceptNullOriginSameOrigin: value as unknown as boolean }),
      ).toThrow(new TypeError('csrfMiddleware: acceptNullOriginSameOrigin must be a boolean.'));
    },
  );

  it('combines duplicated Fetch Metadata header lines and refuses them', async () => {
    const { ctx, response } = createFakeContext({
      request: { method: 'POST', headers: { Origin: 'null' } },
    });
    ctx.request.headers.append('Sec-Fetch-Site', 'same-origin');
    ctx.request.headers.append('Sec-Fetch-Site', 'cross-site');
    let calls = 0;
    await csrfMiddleware()(ctx, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(0);
    expect(response.statuses).toEqual([403]);
  });

  for (const trustedOrigins of [[], ['https://partner.example'], ['null']]) {
    for (const origin of ['null', 'https://partner.example', 'https://foreign.example']) {
      it(`keeps explicit trust ${trustedOrigins.join()} / ${origin}`, async () => {
        const { ctx, response } = createFakeContext({
          request: {
            method: 'POST',
            headers: {
              Origin: origin,
              'Sec-Fetch-Site': 'cross-site',
            },
          },
        });
        let calls = 0;
        await csrfMiddleware({ trustedOrigins })(ctx, () => {
          calls++;
          return Promise.resolve();
        });
        const allowed = trustedOrigins.includes(origin);
        expect(calls).toBe(allowed ? 1 : 0);
        expect(response.statuses).toEqual(allowed ? [] : [403]);
      });
    }
  }
});

describe('CSRF behind a proxy', () => {
  async function check(headers: Record<string, string>, published = false) {
    const { ctx, response } = createFakeContext({
      request: { method: 'POST', url: 'http://internal/form', headers },
    });
    if (published)
      ctx.state.set(REQUEST_ORIGIN_STATE_KEY, { protocol: 'https', host: 'published.example' });
    let downstream = false;
    await csrfMiddleware()(ctx, () => {
      downstream = true;
      return Promise.resolve();
    });
    return { downstream, statuses: response.statuses };
  }
  const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
  it('accepts an https browser POST with zero proxy configuration', async () => {
    expect(
      (await check({ Origin: 'https://internal', 'X-Forwarded-Proto': 'https', ...SAME_ORIGIN }))
        .downstream,
    ).toBe(true);
    expect(
      (
        await check({
          Origin: 'https://public.example',
          'X-Forwarded-Proto': 'HTTPS, http',
          'X-Forwarded-Host': 'public.example, internal',
          'Sec-Fetch-Site': ' Same-Origin ',
        })
      ).downstream,
    ).toBe(true);
  });
  it('ignores the forwarded candidate unless the browser reports same-origin', async () => {
    for (const site of [undefined, 'cross-site', 'same-site', 'none', '']) {
      const result = await check({
        Origin: 'https://partner.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'partner.example',
        ...(site === undefined ? {} : { 'Sec-Fetch-Site': site }),
      });
      expect(result.downstream, String(site)).toBe(false);
      expect(result.statuses).toContain(403);
    }
  });
  it('accepts the published origin through the common accessor', async () => {
    expect((await check({ Origin: 'https://published.example' }, true)).downstream).toBe(true);
  });
  it('ignores ftp, empty and garbage forwarded protocol values', async () => {
    for (const proto of ['ftp', '', 'garbage']) {
      const result = await check({
        Origin: `${proto}://internal`,
        'X-Forwarded-Proto': proto,
        ...SAME_ORIGIN,
      });
      expect(result.downstream, proto).toBe(false);
      expect(result.statuses).toContain(403);
    }
  });
  it('still short-circuits a cross-site origin with forwarded headers present', async () => {
    const result = await check({
      Origin: 'https://evil.example',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'public.example',
      ...SAME_ORIGIN,
    });
    expect(result.downstream).toBe(false);
    expect(result.statuses).toContain(403);
  });
});

describe('csrfMiddleware', () => {
  describe('enabled: false', () => {
    it('returns pass-through middleware', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: { method: 'POST' },
      });
      const mw = csrfMiddleware({ enabled: false });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('safe methods', () => {
    it('GET passes through', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { method: 'GET' } });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('HEAD passes through', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { method: 'HEAD' } });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('OPTIONS passes through', async () => {
      const { ctx, nextCalled } = createFakeContext({ request: { method: 'OPTIONS' } });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('unsafe methods with same-origin', () => {
    it('same-origin Origin passes (implicit self-trust)', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: { Origin: 'https://app.example.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('origin in trustedOrigins passes', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: { Origin: 'https://app.example.com' },
        },
      });
      const mw = csrfMiddleware({
        trustedOrigins: ['https://app.example.com'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('cross-origin rejection', () => {
    it('cross-origin not in trusted set returns 403', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware({
        trustedOrigins: ['https://app.example.com'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
      // M70f (X4-8): the rejection converges on the responder's `detail` key.
      const body = response.body as { error: string; detail: string };
      expect(body.error).toBe('Forbidden');
      expect(body.detail).toBe('Cross-origin request not allowed');
    });

    it('handler not run on 403 short-circuit', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'PUT',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      let handlerRan = false;
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        handlerRan = true;
        nextCalled.push(true);
      });
      expect(handlerRan).toBe(false);
      expect(response.statuses).toContain(403);
    });
  });

  describe('Referer fallback', () => {
    it('uses Referer origin when Origin absent', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: { Referer: 'https://app.example.com/page' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('Referer from untrusted origin rejected', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: { Referer: 'https://evil.com/attack' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });
  });

  describe('both headers absent', () => {
    it('passes through when both headers absent (empty allowlist)', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: {},
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('passes through when both headers absent (non-empty allowlist)', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://api.example.com/endpoint',
          headers: {},
        },
      });
      const mw = csrfMiddleware({
        trustedOrigins: ['https://app.example.com'],
      });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('customHeader', () => {
    it('rejects when custom header absent', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: {
            Origin: 'https://app.example.com',
          },
        },
      });
      const mw = csrfMiddleware({ customHeader: 'X-CSRF-Token' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
      // M70f (X4-8): the rejection converges on the responder's `detail` key.
      const body = response.body as { error: string; detail: string };
      expect(body.error).toBe('Forbidden');
      expect(body.detail).toContain('X-CSRF-Token');
    });

    it('passes when custom header present', async () => {
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          url: 'https://app.example.com/api/data',
          headers: {
            Origin: 'https://app.example.com',
            'X-CSRF-Token': 'abc123',
          },
        },
      });
      const mw = csrfMiddleware({ customHeader: 'X-CSRF-Token' });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });
  });

  describe('PUT/PATCH/DELETE', () => {
    it('PUT is treated as unsafe', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'PUT',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });

    it('PATCH is treated as unsafe', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'PATCH',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });

    it('DELETE is treated as unsafe', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'DELETE',
          url: 'https://api.example.com/resource/1',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });
  });

  describe('exclude (M101c, V8-9)', () => {
    it('an excluded path is checked before the method test and never inspected', async () => {
      // A SAFE method on an excluded path still passes, and the exclusion is
      // what lets an UNSAFE method with an untrusted Origin pass: the path is
      // exempt before the origin is read.
      const { ctx, nextCalled } = createFakeContext({
        request: {
          method: 'POST',
          path: '/auth/corp/acs',
          url: 'https://api.example.com/auth/corp/acs',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware({ exclude: ['/auth/corp/acs'] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(1);
    });

    it('a literal-excluded path with Origin: null passes while a non-excluded path is 403', async () => {
      // The Keycloak reproduction: the IdP serves `Referrer-Policy: no-referrer`,
      // so the browser posts the ACS with `Origin: null`. The exemption admits
      // it; the same header on a non-excluded route is refused.
      const excluded = createFakeContext({
        request: {
          method: 'POST',
          path: '/auth/corp/acs',
          url: 'https://api.example.com/auth/corp/acs',
          headers: { Origin: 'null' },
        },
      });
      const mw = csrfMiddleware({ exclude: ['/auth/corp/acs'] });
      await mw(excluded.ctx, async () => {
        excluded.nextCalled.push(true);
      });
      expect(excluded.nextCalled).toHaveLength(1);

      const notExcluded = createFakeContext({
        request: {
          method: 'POST',
          path: '/login',
          url: 'https://api.example.com/login',
          headers: { Origin: 'null' },
        },
      });
      await mw(notExcluded.ctx, async () => {
        notExcluded.nextCalled.push(true);
      });
      expect(notExcluded.nextCalled).toHaveLength(0);
      expect(notExcluded.response.statuses).toContain(403);
    });

    it('a RegExp-excluded path matches by test, including a `g`-flagged pattern twice in a row', async () => {
      // `createPathMatcher` owns the `lastIndex` reset a `g`/`y`-flagged
      // pattern needs; the second request must match identically.
      const mw = csrfMiddleware({ exclude: [/^\/auth\/[a-z]+\/acs$/] });
      for (let i = 0; i < 2; i++) {
        const { ctx, nextCalled } = createFakeContext({
          request: {
            method: 'POST',
            path: '/auth/corp/acs',
            url: 'https://api.example.com/auth/corp/acs',
            headers: { Origin: 'https://evil.com' },
          },
        });
        await mw(ctx, async () => {
          nextCalled.push(true);
        });
        expect(nextCalled).toHaveLength(1);
      }
    });

    it('exclude: [] is byte-identical to today — nothing is exempt', async () => {
      const { ctx, nextCalled, response } = createFakeContext({
        request: {
          method: 'POST',
          path: '/auth/corp/acs',
          url: 'https://api.example.com/auth/corp/acs',
          headers: { Origin: 'https://evil.com' },
        },
      });
      const mw = csrfMiddleware({ exclude: [] });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });
      expect(nextCalled).toHaveLength(0);
      expect(response.statuses).toContain(403);
    });
  });
});
