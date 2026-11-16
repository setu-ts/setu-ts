import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin, IRequestContext } from '@setu-ts/common';
import { AuthPlugin, AuthPluginConfigurationError, requireAuth } from '../../src/index.ts';

describe('API-key validator outage', () => {
  it.each(['cookie', 'COOKIE', 'Cookie'])(
    'refuses Cookie at registration with and without issuers: %s',
    async (header) => {
      for (const withIssuers of [false, true]) {
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            AuthPlugin({
              jwt: { header, secret: 's'.repeat(48) },
              ...(withIssuers
                ? {
                    issuers: [
                      {
                        name: 'idp',
                        issuer: 'https://idp.test',
                        audience: 'api',
                        keys: { jwksUri: 'https://idp.test/jwks' },
                        toPrincipal: () => ({ id: 'u' }),
                      },
                    ],
                  }
                : {}),
            }),
          ],
        });
        await expect(app.start()).rejects.toThrow('JWT header must not be Cookie');
      }
    },
  );
  it('V12-138 answers fixed Problem Details on protected and public key-bearing requests', async () => {
    const validate = vi.fn(() => {
      throw new Error('db down http://user:pass@db/x for key canary-KEY-77');
    });
    const logs: unknown[] = [];
    const logger: ILogger = {
      level: 'info',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, meta) => {
        logs.push({ message, meta });
      },
      fatal: () => {},
      child: () => logger,
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        {
          name: 'test-logger',
          version: '0.0.0',
          provides: [CAPABILITIES.LOGGER],
          register(ctx): void {
            ctx.services.register(CAPABILITIES.LOGGER, logger);
          },
        } satisfies IPlugin,
        AuthPlugin({ apiKey: { validate } }),
      ],
    });
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0 });
    const handler = vi.fn((ctx: IRequestContext) => ctx.response.text('public'));
    app.router.get('/public', handler);
    app.router.get('/private', { middleware: [requireAuth()], handler });
    await app.start();
    try {
      for (const path of ['/public', '/private']) {
        const response = await app.inject({
          method: 'GET',
          url: `http://localhost${path}`,
          headers: { 'X-API-Key': 'canary-KEY-77' },
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers.get('content-type')).toBe('application/problem+json');
        const body = response.body ?? '';
        expect(JSON.parse(body)).toEqual({
          type: 'about:blank',
          status: 503,
          title: 'Service Unavailable',
          detail: 'Authentication is temporarily unavailable.',
          instance: path,
        });
        expect(body).not.toContain('db down');
        expect(body).not.toContain('pass');
        expect(JSON.parse(body)).not.toHaveProperty('message');
      }
      expect(handler).not.toHaveBeenCalled();
      expect(logs).toHaveLength(2);
      expect(JSON.stringify(logs)).not.toContain('user:pass');
      // F2: no text of the validator's error, and so not the key it echoes, reaches the log.
      expect(JSON.stringify(logs)).not.toContain('canary-KEY-77');
      expect(JSON.stringify(logs)).not.toContain('db down');
      expect(JSON.stringify(logs)).toContain('Authentication is temporarily unavailable. (Error)');
      const response = await app.inject({ method: 'GET', url: 'http://localhost/public' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('public');
      expect(validate).toHaveBeenCalledTimes(2);
    } finally {
      await app.stop();
    }
  });

  it.each(['cookie', 'COOKIE'])(
    'V12-136 refuses apiKey.header %s at registration',
    async (header) => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          AuthPlugin({ apiKey: { header, validate: () => Promise.resolve(null) } }),
        ],
      });
      await expect(app.start()).rejects.toBeInstanceOf(AuthPluginConfigurationError);
    },
  );
});
