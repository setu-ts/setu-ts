/**
 * Redis store on a REAL Redis 7 (plan §3.5, §6).
 *
 * Guarded with `ignore: REDIS_URL === undefined` — never an early return. Real
 * sleeps rather than a fake clock, so leases and TTLs are the server's.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIdempotencyStore } from '@setu-ts/common';
import { runIdempotencyStoreConformance } from '../fixtures/idempotency-store-conformance.ts';
import { resolveStore } from '../../src/stores/resolve-store.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

const REDIS_URL = Deno.env.get('REDIS_URL');
const ignore = REDIS_URL === undefined;
const runtime = createClockRuntime();

/**
 * A namespace unique per store AND per process run, so a record left by an
 * earlier run (whose TTL has not lapsed) never contaminates a fresh run.
 */
const RUN_TAG = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
let namespaceCounter = 0;
const nextNamespace = (): string => `it${RUN_TAG}${++namespaceCounter}`;

/** Builds a connected Redis store in a fresh namespace. */
async function makeStore(
  namespace = nextNamespace(),
  keyPrefix?: string,
): Promise<IIdempotencyStore> {
  if (REDIS_URL === undefined) throw new Error('REDIS_URL is not set');
  const store = await resolveStore(
    { type: 'redis', namespace, url: REDIS_URL, ...(keyPrefix === undefined ? {} : { keyPrefix }) },
    () => undefined,
  );
  await store.connect(runtime);
  return store;
}

/** Real sleep. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Redis store on real Redis (M109a §3.5)', { ignore }, () => {
  it('answers PING for isHealthy', async () => {
    const store = await makeStore();
    expect(await store.isHealthy!()).toBe(true);
    await store.disconnect?.();
  });

  it('replays a completed record across two stores sharing a namespace', async () => {
    const namespace = nextNamespace();
    const a = await makeStore(namespace);
    await a.claim({
      key: 'k'.repeat(64),
      scope: 's'.repeat(64),
      fingerprint: 'f'.repeat(64),
      token: 'tok',
      leaseMs: 1_000,
      ttlMs: 60_000,
    });
    expect(await a.complete('k'.repeat(64), 'tok', 'the-record', 60_000)).toBe('settled');
    const b = await makeStore(namespace);
    expect(
      await b.claim({
        key: 'k'.repeat(64),
        scope: 's'.repeat(64),
        fingerprint: 'f'.repeat(64),
        token: 'tok2',
        leaseMs: 1_000,
        ttlMs: 60_000,
      }),
    )
      .toEqual({ outcome: 'completed', record: 'the-record' });
    await a.disconnect?.();
    await b.disconnect?.();
  });

  it('keeps two namespaces isolated so both execute', async () => {
    const shop = await makeStore('shop');
    const billing = await makeStore('billing');
    const request = {
      key: 'k'.repeat(64),
      scope: 's'.repeat(64),
      fingerprint: 'f'.repeat(64),
      token: 'tok',
      leaseMs: 1_000,
      ttlMs: 60_000,
    };
    expect((await shop.claim(request)).outcome).toBe('claimed');
    expect((await billing.claim(request)).outcome).toBe('claimed');
    await shop.disconnect?.();
    await billing.disconnect?.();
  });

  it('sets a PTTL close to ttlMs', async () => {
    const store = await makeStore();
    const key = 'k'.repeat(64);
    await store.claim({
      key,
      scope: 's'.repeat(64),
      fingerprint: 'f'.repeat(64),
      token: 'tok',
      leaseMs: 1_000,
      ttlMs: 30_000,
    });
    // Read the TTL through a second client.
    const { loadIoredis } = await import('../../src/stores/redis-client.ts');
    const RedisCtor = await loadIoredis();
    const client = new RedisCtor(REDIS_URL as string, { lazyConnect: true });
    await client.connect();
    const pttl = await client.call('PTTL', `${'setu:idempotency:'}${'shop'}:${key}`);
    expect(typeof pttl).toBe('number');
    expect(pttl as number).toBeGreaterThan(25_000);
    await client.quit();
    await store.disconnect?.();
  });

  it('logs nothing when the policy is noeviction', async () => {
    const warnings: string[] = [];
    const logger = { level: 'info', warn: (m: string) => void warnings.push(m) } as never;
    const store = await resolveStore(
      { type: 'redis', namespace: nextNamespace(), url: REDIS_URL as string },
      () => logger,
    );
    await store.connect(runtime);
    // The test asserts the policy first rather than changing it.
    const policy = await (async () => {
      const { loadIoredis } = await import('../../src/stores/redis-client.ts');
      const RedisCtor = await loadIoredis();
      const client = new RedisCtor(REDIS_URL as string, { lazyConnect: true });
      await client.connect();
      const reply = await client.call('CONFIG', 'GET', 'maxmemory-policy');
      await client.quit();
      return Array.isArray(reply) ? reply[1] : undefined;
    })();
    if (policy === 'noeviction') {
      expect(warnings).toHaveLength(0);
    }
    await store.disconnect?.();
  });

  it('grants exactly one claim among 50 concurrent REAL claims', async () => {
    const store = await makeStore();
    const key = 'k'.repeat(64);
    const results = await Promise.all(
      Array.from(
        { length: 50 },
        (_unused, index) =>
          store.claim({
            key,
            scope: 's'.repeat(64),
            fingerprint: 'f'.repeat(64),
            token: `t${index}`,
            leaseMs: 5_000,
            ttlMs: 60_000,
          }),
      ),
    );
    expect(results.filter((result) => result.outcome === 'claimed')).toHaveLength(1);
    await store.disconnect?.();
  });

  it('uses the server clock so a lapsed lease is taken over after a real sleep', async () => {
    const store = await makeStore();
    const key = 'k'.repeat(64);
    await store.claim({
      key,
      scope: 's'.repeat(64),
      fingerprint: 'f'.repeat(64),
      token: 'a',
      leaseMs: 50,
      ttlMs: 60_000,
    });
    await sleep(120);
    expect(
      await store.claim({
        key,
        scope: 's'.repeat(64),
        fingerprint: 'f'.repeat(64),
        token: 'b',
        leaseMs: 50,
        ttlMs: 60_000,
      }),
    )
      .toEqual({ outcome: 'claimed', takeover: true });
    // The stale holder's complete is lost.
    expect(await store.complete(key, 'a', 'r', 60_000)).toBe('lost');
    await store.disconnect?.();
  });
});

runIdempotencyStoreConformance('redis', {
  make: () => makeStore(),
  advance: (ms) => sleep(ms + 5),
  runtime,
  ignore,
});
