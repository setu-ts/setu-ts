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
  it('should apply the configured TTL to BOTH the dead set and the jobs hash', async () => {
    // Both keys retain data for the dead job, so bounding only one would leave
    // the other growing — and the jobs hash is the one holding the payload.
    const client = new FakeRedisClient();
    const queue = new RedisQueue({ client, deadLetterTtlMs: 90_000 });
    await queue.connect();
    await queue.enqueue(JOB);

    await queue.deadLetter('thumbnail', 'job-1', 1_700_000_000_000, 'job-1');

    expect(expireCalls(client)).toEqual([
      ['queue:thumbnail:dead', 90],
      ['queue:thumbnail:jobs', 90],
    ]);
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
