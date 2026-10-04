/**
 * Real Redis outage for the cache (M101a V8-5), through a real kernel app.
 *
 * `docker pause` freezes Redis while its socket stays open, so ioredis sees
 * neither an error nor a close: before this letter a cache command against it
 * waited forever, and so did the request that issued it. With
 * `commandTimeoutMs: 1000` the paused `get` REJECTS inside the bound, the
 * diagnostics source counts it `failed`, the route answers (the kernel's
 * `500` — status classification for a cache outage is out of this letter's
 * scope), and `/health` reports the cache indicator `down`. After unpause the
 * same route answers `200` again.
 *
 * Guarded with `ignore:` on `REDIS_URL` (never an early return, so an unset
 * variable is reported as IGNORED rather than passing). CI sets it and runs
 * Redis as a service container; `test/apps-gate.test.ts` pins that wiring. The
 * container is found by its published port and unpaused on every exit.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  HandlerResult,
  ICacheDiagnosticsSource,
  ICacheStore,
  IRequestContext,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';

import { CachePlugin } from '../../src/index.ts';

const redisUrl = Deno.env.get('REDIS_URL');
const BOUND_MS = 1000;

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') throw new Error(`no container publishing port ${port}`);
  return ids.split('\n')[0];
}

/** Polls `/health` until the cache indicator reports `status`. */
async function waitForCache(
  app: ReturnType<typeof createApplication>,
  status: string,
): Promise<{ statusCode: number; cache: string | undefined }> {
  const deadline = performance.now() + 20_000;
  let last: { statusCode: number; cache: string | undefined } = {
    statusCode: 0,
    cache: undefined,
  };
  while (performance.now() < deadline) {
    const health = await app.inject({ method: 'GET', url: 'http://localhost/health' });
    const checks = (health.json() as { checks?: Record<string, { status: string }> }).checks;
    last = { statusCode: health.statusCode, cache: checks?.['cache']?.status };
    if (last.cache === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

describe('REAL Redis cache outage (M101a V8-5)', { ignore: redisUrl === undefined }, () => {
  it('paused Redis → get rejects within the bound, counted failed, /health down → unpaused → 200', async () => {
    const url = redisUrl!.replace(/localhost/g, '127.0.0.1');
    const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
    const containerId = await containerIdForPort(port);

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({
          store: 'redis',
          options: { url, prefix: `m101a-${crypto.randomUUID()}:`, commandTimeoutMs: BOUND_MS },
          diagnostics: { enabled: true, alias: 'primary' },
        }),
        HealthPlugin(),
      ],
    });
    app.router.get('/cached', {
      handler: async (ctx: IRequestContext): Promise<HandlerResult> => {
        const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
        return ctx.response.json({ value: await cache.get('k') });
      },
    });
    await app.start();

    let paused = false;
    try {
      const baseline = await app.inject({ method: 'GET', url: 'http://localhost/cached' });
      expect(baseline.statusCode).toBe(200);

      await docker(['pause', containerId]);
      paused = true;

      const started = performance.now();
      const refused = await app.inject({ method: 'GET', url: 'http://localhost/cached' });
      const elapsed = performance.now() - started;
      expect(refused.statusCode).toBe(500);
      expect(elapsed).toBeLessThan(BOUND_MS * 3);

      const [source] = app.services.getAll<ICacheDiagnosticsSource>(
        CAPABILITIES.CACHE_DIAGNOSTICS,
      );
      const get = source.snapshot().records.find((record) => record.operation === 'get');
      expect(get).toMatchObject({ count: 2, succeeded: 1, failed: 1 });

      const down = await waitForCache(app, 'down');
      expect(down).toEqual({ statusCode: 503, cache: 'down' });

      await docker(['unpause', containerId]);
      paused = false;
      const recovered = await app.inject({ method: 'GET', url: 'http://localhost/cached' });
      expect(recovered.statusCode).toBe(200);
    } finally {
      if (paused) await docker(['unpause', containerId]).catch(() => '');
      await app.stop();
    }
  });
});
