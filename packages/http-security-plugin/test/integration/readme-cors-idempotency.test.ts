import * as nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { corsMiddleware, HttpSecurityPlugin } from '../../src/index.ts';

// These are the CORS options in the README's registration example.
const corsOptions = {
  origin: 'https://example.com',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  // Omit `allowedHeaders` and an allowed origin's preflight echoes whatever
  // the browser asked for. List them here to allow only those.
  allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-csrf-token'],
  exposedHeaders: ['idempotent-replayed'],
  maxAge: 86400,
};

describe('README CORS options for keyed SDK calls', () => {
  it('serves the README CORS + CSRF preflight and POST (V10-3)', async () => {
    const readme = await nodeFs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const headerLiteral = /allowedHeaders:\s*\[([^\]]+)\]/.exec(readme)?.[1];
    expect(headerLiteral).toBeDefined();
    const allowedHeaders = [...headerLiteral!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HttpSecurityPlugin({
          cors: { ...corsOptions, allowedHeaders },
          csrf: { trustedOrigins: ['https://example.com'], customHeader: 'X-CSRF-Token' },
        }),
      ],
    });
    let calls = 0;
    app.router.post('/orders', (ctx) => {
      calls++;
      return ctx.response.json({ ok: true });
    });
    await app.start();
    try {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: 'http://internal/orders',
        headers: {
          Origin: corsOptions.origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-csrf-token',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Headers')?.split(/,\s*/)).toContain(
        'x-csrf-token',
      );
      expect(calls).toBe(0);
      for (const includeHeader of [false, true]) {
        const response = await app.inject({
          method: 'POST',
          url: 'http://internal/orders',
          headers: {
            Origin: corsOptions.origin,
            'Sec-Fetch-Site': 'cross-site',
            ...(includeHeader ? { 'X-CSRF-Token': 'present' } : {}),
          },
        });
        expect(response.statusCode).toBe(includeHeader ? 200 : 403);
      }
      expect(calls).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('serves a navigation POST under DEFAULT no-referrer headers (V10-1)', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), HttpSecurityPlugin({ csrf: {} })] });
    app.router.post('/form', (ctx) => ctx.response.json({ ok: true }));
    await app.start();
    try {
      for (const site of ['same-origin', 'cross-site', 'same-site', 'none']) {
        const response = await app.inject({
          method: 'POST',
          url: 'http://internal/form',
          headers: {
            Origin: 'null',
            'Sec-Fetch-Site': site,
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
          },
        });
        expect(response.statusCode).toBe(site === 'same-origin' ? 200 : 403);
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      }
    } finally {
      await app.stop();
    }
  });
  it('refuses the same navigation POST when acceptNullOriginSameOrigin is false (L2 opt-out)', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HttpSecurityPlugin({ csrf: { acceptNullOriginSameOrigin: false } }),
      ],
    });
    let handled = 0;
    app.router.post('/form', (ctx) => {
      handled++;
      return ctx.response.json({ ok: true });
    });
    await app.start();
    try {
      const response = await app.inject({
        method: 'POST',
        url: 'http://internal/form',
        headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
      });
      expect(response.statusCode).toBe(403);
      expect(handled).toBe(0);
      // Positive control: a real same origin still passes with the opt-out.
      const own = await app.inject({
        method: 'POST',
        url: 'http://internal/form',
        headers: { Origin: 'http://internal', 'Sec-Fetch-Site': 'same-origin' },
      });
      expect(own.statusCode).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it('allows the key in preflight and exposes the replay header on a simple request', async () => {
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.middleware.add(corsMiddleware(corsOptions));
    let effects = 0;
    app.router.get('/orders', (ctx) => {
      effects++;
      return ctx.response.header('Idempotent-Replayed', 'true').json({ ok: true });
    });
    await app.start();
    try {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: 'http://localhost/orders',
        headers: {
          Origin: corsOptions.origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, idempotency-key',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Headers')?.split(/,\s*/)).toContain(
        'idempotency-key',
      );
      expect(effects).toBe(0);
      const response = await app.inject({
        method: 'GET',
        url: 'http://localhost/orders',
        headers: { Origin: corsOptions.origin },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers.get('Access-Control-Expose-Headers')?.split(/,\s*/)).toContain(
        'idempotent-replayed',
      );
      expect(response.headers.get('Idempotent-Replayed')).toBe('true');
      expect(effects).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('pins the exact CORS options literal to the README TypeScript fence', async () => {
    const readme = await nodeFs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const source = await nodeFs.readFile(
      new URL('./readme-cors-idempotency.test.ts', import.meta.url),
      'utf8',
    );
    const literal = source.slice(
      source.indexOf('const corsOptions = {') + 'const corsOptions = '.length,
      source.indexOf('\n};') + 2,
    );
    const fences = [...readme.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const normalize = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
    expect(fences.some((fence) => normalize(fence).includes(normalize(literal)))).toBe(true);
  });
});
