/**
 * The request-size refusals carry the same security and CORS headers as every other response:
 * security headers run at priority 10 and CORS at 125, both before request size (180).
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_IP_STATE_KEY } from '@setu-ts/common';
import type { IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import type { HttpSecurityPluginOptions } from '../../src/plugin/http-security-plugin.ts';
import { HttpSecurityPlugin } from '../../src/plugin/http-security-plugin.ts';

const ORIGIN = 'https://app.example';

async function appWith(options: HttpSecurityPluginOptions) {
  const app = createApplication({ plugins: [RuntimePlugin(), HttpSecurityPlugin(options)] });
  app.router.post('/x', (ctx) => ctx.response.json({ ok: true }));
  await app.start();
  return app;
}

function post(origin: string, contentLength: string, body: string) {
  return {
    method: 'POST',
    url: 'http://localhost/x',
    headers: { origin, 'content-type': 'application/json', 'content-length': contentLength },
    body,
  } as const;
}

describe('refusal headers', () => {
  it('a 413 carries the CORS and security headers an allowed origin gets on a 200', async () => {
    const app = await appWith({ cors: { origin: ORIGIN }, requestSize: { maxBodySize: 10 } });
    try {
      const ok = await app.inject(post(ORIGIN, '2', '{}'));
      const big = await app.inject(post(ORIGIN, '100', 'x'.repeat(100)));
      expect(ok.statusCode).toBe(200);
      expect(big.statusCode).toBe(413);
      for (const res of [ok, big]) {
        expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
        expect(res.headers.get('vary')).toContain('Origin');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('strict-transport-security')).not.toBeNull();
      }
    } finally {
      await app.stop();
    }
  });

  it('a 400 for a malformed Content-Length carries them too', async () => {
    const app = await appWith({ cors: { origin: ORIGIN }, requestSize: { maxBodySize: 10 } });
    try {
      const bad = await app.inject(post(ORIGIN, 'abc', '{}'));
      expect(bad.statusCode).toBe(400);
      expect(bad.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(bad.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await app.stop();
    }
  });

  it('a disallowed origin still gets no CORS header on a refusal', async () => {
    const app = await appWith({ cors: { origin: ORIGIN }, requestSize: { maxBodySize: 10 } });
    try {
      const big = await app.inject(post('https://evil.example', '100', 'x'.repeat(100)));
      expect(big.statusCode).toBe(413);
      expect(big.headers.get('access-control-allow-origin')).toBeNull();
      expect(big.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await app.stop();
    }
  });

  it('a preflight still answers 204 with the CORS headers', async () => {
    const app = await appWith({ cors: { origin: ORIGIN }, requestSize: { maxBodySize: 10 } });
    try {
      const pre = await app.inject({
        method: 'OPTIONS',
        url: 'http://localhost/x',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    } finally {
      await app.stop();
    }
  });

  it('an origin matcher still sees the client address IP security resolved', async () => {
    const seen: unknown[] = [];
    const app = await appWith({
      ipSecurity: { trustProxy: true },
      cors: {
        origin: (origin: string, ctx: IRequestContext) => {
          seen.push(ctx.state.get(CLIENT_IP_STATE_KEY));
          return origin === ORIGIN;
        },
      },
      requestSize: { maxBodySize: 10 },
    });
    try {
      const request = post(ORIGIN, '100', 'x'.repeat(100));
      const big = await app.inject({
        ...request,
        headers: { ...request.headers, 'x-forwarded-for': '203.0.113.7' },
      });
      expect(big.statusCode).toBe(413);
      expect(big.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toBe('203.0.113.7');
    } finally {
      await app.stop();
    }
  });
});
