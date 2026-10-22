/** Real cache, cache-session and limiter outage responses through kernel apps. @module */
import { describe, expect, it } from 'vitest';
import type { ICacheStore, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { RedisRateLimitStore, rateLimitMiddleware } from '@setu-ts/auth-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { SessionPlugin, getSession } from '../../src/index.ts';
import { run as runProcess } from '../../../../test/node-helpers.ts';

const redisUrl = process.env['REDIS_URL'];
const BOUND_MS = 300;

async function docker(...args: string[]): Promise<string> {
  const result = await runProcess('docker', { args });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function containerFor(url: string): Promise<string> {
  const port = new URL(url).port || '6379';
  const shard = process.env['SETU_CI_SHARD'];
  const filters = shard
    ? ['--filter', `label=setu.ci.shard=${shard}`, '--filter', `label=setu.ci.port.${port}=1`]
    : ['--filter', `publish=${port}`];
  const ids = await docker('ps', '-q', ...filters);
  if (ids.split('\n').length !== 1 || ids === '')
    throw new Error('expected exactly one Redis test container');
  return ids;
}

describe('M113b real Redis RFC 9457 outage responses', { skip: redisUrl === undefined }, () => {
  for (const outage of ['paused', 'stopped'] as const) {
    for (const route of ['cache', 'session', 'rate-limit'] as const) {
      it(`${route}: ${outage} Redis answers 503 without driver text and recovers`, async () => {
        const url = redisUrl!.replace(/localhost/g, '127.0.0.1');
        const container = await containerFor(url);
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            ...(route === 'rate-limit'
              ? []
              : [
                  CachePlugin({
                    store: 'redis',
                    options: {
                      url,
                      prefix: `m113b:${crypto.randomUUID()}:`,
                      commandTimeoutMs: BOUND_MS,
                    },
                  }),
                ]),
            ...(route === 'session'
              ? [
                  SessionPlugin({
                    secret: 'm113b-session-secret-at-least-32-characters',
                    store: 'cache',
                  }),
                ]
              : []),
          ],
        });
        app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 1 });
        await app.start();
        let limiter: RedisRateLimitStore | undefined;
        if (route === 'rate-limit') {
          limiter = new RedisRateLimitStore({
            url,
            runtime: app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
            commandTimeoutMs: BOUND_MS,
            keyPrefix: `m113b:${crypto.randomUUID()}:`,
            connectionErrorReporter: { report: () => {}, recovered: () => {} },
          });
        }
        app.router.get('/probe', {
          ...(limiter === undefined
            ? {}
            : { middleware: [rateLimitMiddleware({ store: limiter, windowMs: 60000, max: 100 })] }),
          handler: async (ctx) => {
            if (route === 'cache') {
              const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
              await cache.set('k', 'read-back');
              return ctx.response.json({ value: await cache.get('k') });
            }
            if (route === 'session') {
              const session = getSession(ctx);
              session.set('count', (session.get<number>('count') ?? 0) + 1);
              return ctx.response.json({ count: session.get('count') });
            }
            return ctx.response.json({ admitted: true });
          },
        });
        let affected = false;
        try {
          const baseline = await app.inject({ method: 'GET', url: '/probe' });
          expect(baseline.statusCode).toBe(200);
          if (route === 'cache') expect(baseline.json()).toEqual({ value: 'read-back' });
          const cookie = baseline.headers.get('set-cookie')?.split(';')[0];
          const request = {
            method: 'GET' as const,
            url: '/probe',
            ...(cookie === undefined ? {} : { headers: { cookie } }),
          };
          if (route === 'session') {
            expect(cookie).toBeDefined();
            expect((await app.inject(request)).json()).toEqual({ count: 2 });
          }
          await docker(outage === 'paused' ? 'pause' : 'stop', container);
          affected = true;
          const response = await app.inject(request);
          expect(response.statusCode).toBe(503);
          expect(response.headers.get('content-type')).toContain('application/problem+json');
          expect(response.json()).toEqual({
            type: 'about:blank',
            title: 'Service Unavailable',
            status: 503,
            detail:
              route === 'rate-limit'
                ? 'Rate limiting is temporarily unavailable.'
                : 'The cache is temporarily unavailable.',
            instance: '/probe',
          });
          expect(response.body).not.toMatch(
            /Command timed out|ECONN|MaxRetries|Stream isn't writeable|Connection is closed/,
          );
          await docker(outage === 'paused' ? 'unpause' : 'start', container);
          affected = false;
          let recovered = await app.inject(request);
          for (let i = 0; recovered.statusCode !== 200 && i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            recovered = await app.inject(request);
          }
          expect(recovered.statusCode).toBe(200);
        } finally {
          if (affected) await docker(outage === 'paused' ? 'unpause' : 'start', container);
          await limiter?.disconnect();
          await app.stop();
        }
      });
    }
  }
});
