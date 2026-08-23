/**
 * X8-4 — bounding the retained dead-letter payload, and counting what is there.
 *
 * `RedisQueue.deadLetter` moved the id into the dead set and left the payload in
 * the jobs hash "for debugging" with no TTL and no trim, so that hash grew
 * without bound for the lifetime of the deployment. Measured on the live app:
 * `TTL queue:thumbnail:dead` and `TTL queue:thumbnail:jobs` both answered `-1`.
 *
 * The TTL is opt-in, because dropping a dead job's payload by default would
 * remove the debugging value the retention exists for.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import type { IRedisQueueClient } from '../../src/interfaces/index.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';

/** A stored job on its final delivery. */
const JOB: StoredJob = {
  id: 'job-1',
  name: 'thumbnail',
  data: { key: 'photo.png' },
  attempts: 3,
  maxAttempts: 3,
  availableAtMs: 0,
};

/**
 * Wraps the fake in a plain object that delegates every method but OMITS the
 * named ones — the shape an injected client without those commands has.
 *
 * A `Object.create(client, …)` override cannot stand in: the fake's methods
 * read private fields, which throw `Receiver must be an instance of` on a
 * derived object.
 */
function withoutCommands(
  client: FakeRedisClient,
  omit: readonly string[],
): IRedisQueueClient {
  const delegate: Record<string, unknown> = {};
  for (
    const key of [
      'zadd',
      'zrangebyscore',
      'zrem',
      'hset',
      'hget',
      'hdel',
      'del',
      'quit',
      'connect',
      'ping',
      'zcard',
      'expire',
    ]
  ) {
    if (omit.includes(key)) continue;
    const method = (client as unknown as Record<string, unknown>)[key];
    if (typeof method === 'function') {
      delegate[key] = (...args: unknown[]) =>
        (method as (...a: unknown[]) => unknown).apply(client, args);
    }
  }
  return delegate as unknown as IRedisQueueClient;
}

/** Reads the arguments of every `expire` the adapter issued. */
function expireCalls(client: FakeRedisClient): unknown[][] {
  return client.calls.filter((call) => call.method === 'expire').map((call) => call.args);
}

describe('RedisQueue dead-letter retention (X8-4)', () => {
  it('should expire the dead set and a DEDICATED payload key, never the live jobs hash', async () => {
    // `queue:<name>:jobs` holds the payload of EVERY job for this name, not
    // only dead ones. Expiring it destroys work that is merely queued: Redis
    // keeps a key's TTL across later HSETs, so jobs enqueued after the first
    // dead-letter inherit the countdown, and `reserve` drops a job whose
    // payload is missing into the processing set and never returns it.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client, deadLetterTtlMs: 90_000 });
    await queue.connect();
    await queue.enqueue(JOB);

    await queue.deadLetter('thumbnail', 'job-1', 1_700_000_000_000, 'job-1');

    expect(expireCalls(client)).toEqual([
      ['queue:thumbnail:dead', 90],
      ['queue:thumbnail:dead:jobs', 90],
    ]);
    expect(expireCalls(client).map(([key]) => key)).not.toContain('queue:thumbnail:jobs');
  });

  it('should move the dead payload out of the live jobs hash, not copy it', async () => {
    // Retention must not leave the payload in the hash the TTL cannot bound,
    // or the growth X8-4 reported would continue unchecked beside the copy.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client, deadLetterTtlMs: 90_000 });
    await queue.connect();
    await queue.enqueue(JOB);

    await queue.deadLetter('thumbnail', 'job-1', 0, 'job-1');

    expect(await client.hget('queue:thumbnail:dead:jobs', 'job-1')).not.toBeNull();
    expect(await client.hget('queue:thumbnail:jobs', 'job-1')).toBeNull();
  });

  it('should leave a queued job reservable once the armed expiries actually fire', async () => {
    // The consequence the key choice exists to prevent, driven end to end. The
    // fake records an EXPIRE without enforcing it, so the test applies what the
    // adapter armed — deleting exactly the keys it asked Redis to expire — and
    // then reserves. Pointed at the live jobs hash this fails: `job-2`'s
    // payload is gone, and `reserve` moves it to the processing set and returns
    // nothing, losing it permanently.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client, deadLetterTtlMs: 90_000 });
    await queue.connect();
    await queue.enqueue(JOB);
    await queue.enqueue({ ...JOB, id: 'job-2' });

    await queue.deadLetter('thumbnail', 'job-1', 0, 'job-1');

    for (const [key] of expireCalls(client)) {
      await client.del(String(key));
    }

    const reserved = await queue.reserve('thumbnail', 10, JOB.availableAtMs + 1);
    expect(reserved.map((job) => job.id)).toEqual(['job-2']);
  });

  it('should round a sub-second TTL up to one second rather than to zero', async () => {
    // `EXPIRE 0` deletes the key immediately, which would discard the payload
    // the option exists to retain briefly.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client, deadLetterTtlMs: 200 });
    await queue.connect();
    await queue.enqueue(JOB);

    await queue.deadLetter('thumbnail', 'job-1', 0, 'job-1');

    expect(expireCalls(client).map((args) => args[1])).toEqual([1, 1]);
  });

  it('should issue NO expire when the TTL is not configured', async () => {
    // The default keeps today's behaviour; the retention is opt-in.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();
    await queue.enqueue(JOB);

    await queue.deadLetter('thumbnail', 'job-1', 0, 'job-1');

    expect(expireCalls(client)).toEqual([]);
  });

  it('should skip the TTL when the injected client cannot expire', async () => {
    // `expire` is optional on the structural client so an existing fake still
    // type-checks; reporting a retention the client cannot enforce would be
    // worse than not applying one.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({
      client: withoutCommands(client, ['expire']),
      deadLetterTtlMs: 90_000,
    });
    await queue.connect();
    await queue.enqueue(JOB);

    await queue.deadLetter('thumbnail', 'job-1', 0, 'job-1');

    expect(expireCalls(client)).toEqual([]);
  });
});

describe('RedisQueue depths (X8-4)', () => {
  it('should count all three states with one ZCARD each', async () => {
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();
    await queue.enqueue(JOB);
    await queue.enqueue({ ...JOB, id: 'job-2' });

    // Reserve BOTH so they leave the ready set, then dead-letter one. Reserving
    // only one would leave the other in `ready`, and `deadLetter` removes from
    // `processing` — a job can be in `ready` and `dead` at once, which is a real
    // property of the adapter rather than something to paper over here.
    await queue.reserve('thumbnail', 2, 1_700_000_000_000);
    await queue.deadLetter('thumbnail', 'job-2', 0, 'job-2');

    expect(await queue.depths!('thumbnail')).toEqual({
      ready: 0,
      processing: 1,
      dead: 1,
    });
  });

  it('should report zeros for a name with nothing in it, not an error', async () => {
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();

    expect(await queue.depths!('never-used')).toEqual({
      ready: 0,
      processing: 0,
      dead: 0,
    });
  });

  it('should OMIT depths entirely when the client cannot count a sorted set', async () => {
    // Absence is the signal: the health indicator must be able to tell "this
    // adapter cannot report" from "there is nothing there".
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client: withoutCommands(client, ['zcard']) });

    await queue.connect();

    expect(queue.depths).toBeUndefined();
  });
});
