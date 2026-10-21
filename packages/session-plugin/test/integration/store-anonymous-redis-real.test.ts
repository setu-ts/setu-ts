/**
 * V9-46 against a REAL Redis (M113e plan §3.3): the finding measured 200
 * anonymous `GET /login` views adding 200 keys through `store: 'cache'`. With
 * the cookie-held rule they add none, and signing in adds exactly one.
 *
 * Keys are counted with `redis-cli --scan` inside the container publishing
 * `REDIS_URL`'s port, under a per-run prefix, so the count is this test's own.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { getCsrfToken, getSession, SessionPlugin } from '../../src/index.ts';
import { run as runProcess } from '../../../../test/node-helpers.ts';

const redisUrl = process.env['REDIS_URL'];

async function docker(...args: string[]): Promise<string> {
  const result = await runProcess('docker', { args });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function keysUnder(url: string, prefix: string): Promise<number> {
  const port = new URL(url).port || '6379';
  const shard = process.env['SETU_CI_SHARD'];
  const filters = shard
    ? ['--filter', `label=setu.ci.shard=${shard}`, '--filter', `label=setu.ci.port.${port}=1`]
    : ['--filter', `publish=${port}`];
  const ids = (await docker('ps', '-q', ...filters)).split('\n').filter((id) => id !== '');
  if (ids.length !== 1) {
    throw new Error(`Expected one container publishing port ${port}, found ${ids.length}`);
  }
  const out = await docker('exec', ids[0], 'redis-cli', '--scan', '--pattern', `${prefix}*`);
  return out === '' ? 0 : out.split('\n').length;
}

describe('M113e cookie-held sessions over real Redis', { skip: redisUrl === undefined }, () => {
  it('200 anonymous form views add no key; signing in adds one', async () => {
    const url = redisUrl!.replace(/localhost/g, '127.0.0.1');
    const prefix = `m113e:${crypto.randomUUID()}:`;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'redis', options: { url, prefix } }),
        SessionPlugin({
          secret: 'm113e-redis-session-secret-at-least-32-chars',
          store: 'cache',
          cookie: { secure: false },
          csrf: {},
        }),
      ],
    });
    app.router.get('/login', (ctx) => ctx.response.json({ token: getCsrfToken(ctx) }));
    app.router.post('/login', (ctx) => {
      getSession(ctx).regenerate();
      getSession(ctx).set('user', 'ann');
      return ctx.response.json({ ok: true });
    });
    await app.start();
    try {
      let cookie = '';
      let token = '';
      for (let index = 0; index < 200; index += 1) {
        const response = await app.fetch(new Request('http://localhost/login'));
        cookie = (response.headers.get('set-cookie') as string).split(';')[0];
        token = ((await response.json()) as { token: string }).token;
      }
      expect(await keysUnder(url, prefix)).toBe(0);

      const login = await app.fetch(
        new Request('http://localhost/login', {
          method: 'POST',
          headers: { cookie, 'x-csrf-token': token },
        }),
      );
      expect(login.status).toBe(200);
      await login.body?.cancel();
      expect(await keysUnder(url, prefix)).toBe(1);
    } finally {
      await app.stop();
    }
  });
});
