/**
 * `setu add` Redis arm flags (M131a X88-1): `--store redis`, `--lock redis`,
 * `--backplane redis` (and `--store` for idempotency) wire each plugin's Redis
 * arm on `REDIS_URL` through the project's inferred client. A node-redis project
 * gets `client: nodeRedisClient(url)` and no `ioredis` dependency; an ioredis
 * project gets `url`. `--redis-client` is refused when it disagrees with the
 * inferred client.
 *
 * The arm rendering is asserted at the transport-spec level (the unit where the
 * call is actually rendered); the refusal cases are asserted end-to-end.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import { getTransport } from '../../src/workspace/transport.ts';

function harness() {
  const fs = createFakeFs();
  const errors: string[] = [];
  return {
    fs,
    errors,
    run: (args: readonly string[]) =>
      runCli(args, {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: (line) => errors.push(line),
      }),
  };
}

describe('setu add Redis arm flags (M131a X88-1)', () => {
  it('renders each arm through the inferred node-redis client, with no ioredis', () => {
    const spec = getTransport('redis', 'node-redis')!;
    // The node-redis arm renders `nodeRedisClient(<read>)` for every arm.
    const read = 'process.env.REDIS_URL ?? "redis://127.0.0.1:6379"';
    expect(spec.cacheArgs!(read)).toBe(`{ store: 'redis', options: { client: nodeRedisClient(${read}) } }`);
    expect(spec.idempotencyArgs!(read)).toBe(
      `{ store: { type: 'redis', namespace: 'setu', client: nodeRedisClient(${read}) } }`,
    );
    expect(spec.schedulerArgs!(read)).toBe(
      `{ distributedLock: { enabled: true, storage: 'redis', client: nodeRedisClient(${read}) } }`,
    );
    const backplane = spec.backplaneArgs!(read);
    expect(backplane).toContain(`client: nodeRedisClient(${read})`);
    expect(backplane).toContain(`subscriber: nodeRedisClient(${read})`);
    // The node-redis arm records the `redis` package, never `ioredis`.
    expect(spec.queueClients).toContain('redis');
    expect(spec.messagingClients).toContain('redis');
    expect(spec.redisClient).toBe('node-redis');
  });

  it('renders each arm through ioredis as a url, with the ioredis dependency', () => {
    const spec = getTransport('redis', 'ioredis')!;
    const read = 'process.env.REDIS_URL ?? "redis://127.0.0.1:6379"';
    expect(spec.cacheArgs!(read)).toBe(`{ store: 'redis', options: { url: ${read} } }`);
    expect(spec.idempotencyArgs!(read)).toBe(
      `{ store: { type: 'redis', namespace: 'setu', url: ${read} } }`,
    );
    expect(spec.schedulerArgs!(read)).toBe(
      `{ distributedLock: { enabled: true, storage: 'redis', url: ${read} } }`,
    );
    expect(spec.queueClients).toContain('ioredis');
    // ioredis is the default client, so the spec carries no explicit `redisClient`.
    expect(spec.redisClient).toBeUndefined();
  });

  it('refuses an arm flag on the wrong plugin', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'microservice']);
    h.errors.length = 0;
    expect(await h.run(['add', 'queue', '--store', 'redis', '--dir', '/work/svc'])).toBe(2);
    expect(h.errors.join('\n')).toContain('--store applies only to setu add cache or idempotency');
  });

  it('refuses --redis-client that disagrees with the inferred client', async () => {
    const h = harness();
    // A fresh ioredis project (no node-redis helper).
    await h.run(['new', 'svc', '--template', 'microservice']);
    h.errors.length = 0;
    expect(
      await h.run([
        'add',
        'cache',
        '--store',
        'redis',
        '--redis-client',
        'node-redis',
        '--dir',
        '/work/svc',
      ]),
    ).toBe(2);
    expect(h.errors.join('\n')).toContain(
      "--redis-client node-redis disagrees with the project's ioredis client.",
    );
  });

  it('refuses --redis-client with no Redis arm flag', async () => {
    const h = harness();
    await h.run(['new', 'svc', '--template', 'microservice']);
    h.errors.length = 0;
    expect(await h.run(['add', 'cache', '--redis-client', 'node-redis', '--dir', '/work/svc'])).toBe(2);
    expect(h.errors.join('\n')).toContain('--redis-client requires a Redis arm');
  });
});
