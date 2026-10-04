/**
 * M101a: every multi-command RedisQueue transition runs as one Lua script when
 * the client exposes `eval`, so a command timeout the server still applies can
 * leave the transition whole or absent, never half-applied.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import {
  ACK_SCRIPT,
  DEAD_LETTER_SCRIPT,
  ENQUEUE_SCRIPT,
  REQUEUE_SCRIPT,
  RESERVE_SCRIPT,
} from '../../src/adapters/redis-queue-scripts.ts';
import { FakeEvalRedisClient, FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';

const job = (id: string): StoredJob<{ n: number }> => ({
  id,
  name: 'email',
  data: { n: 1 },
  attempts: 0,
  maxAttempts: 3,
  availableAtMs: 100,
});

/** Where a job is: which sets hold it, and whether its payload survives. */
async function locate(client: FakeRedisClient, id: string) {
  const ready = await client.zrangebyscore('queue:email:ready', '-inf', '+inf');
  const processing = await client.zrangebyscore('queue:email:processing', '-inf', '+inf');
  return {
    ready: ready.includes(id),
    processing: processing.includes(id),
    payload: (await client.hget('queue:email:jobs', id)) !== null,
  };
}

/** Makes the first call to `method` apply its effect and THEN reject, as a
 * command does when the client's timeout fires before the server answers. */
function timeOutAfterApplying<C extends FakeRedisClient>(client: C, method: 'zrem' | 'eval'): C {
  const target = client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = target[method];
  let fired = false;
  target[method] = async (...args: unknown[]) => {
    const result = await original.apply(client, args);
    if (!fired) {
      fired = true;
      throw new Error('Command timed out');
    }
    return result;
  };
  return client;
}

describe('RedisQueue atomic transitions (eval present)', () => {
  it('runs enqueue, reserve, requeue and ack as one script each', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();

    await queue.enqueue(job('j1'));
    const reserved = await queue.reserve<{ n: number }>('email', 10, 100);
    expect(reserved.map((j) => j.id)).toEqual(['j1']);
    expect(reserved[0].data).toEqual({ n: 1 });

    await queue.requeue('email', 'j1', 200, 1);
    expect(await locate(client, 'j1')).toEqual({ ready: true, processing: false, payload: true });
    const again = await queue.reserve<{ n: number }>('email', 10, 200);
    expect(again[0].attempts).toBe(1);
    expect(again[0].availableAtMs).toBe(200);

    await queue.ack('email', 'j1');
    expect(await locate(client, 'j1')).toEqual({ ready: false, processing: false, payload: false });

    expect(client.evals.map((e) => e[0])).toEqual([
      ENQUEUE_SCRIPT,
      RESERVE_SCRIPT,
      REQUEUE_SCRIPT,
      RESERVE_SCRIPT,
      ACK_SCRIPT,
    ]);
    // KEYS then ARGV, with numKeys naming how many keys lead.
    expect(client.evals[1]).toEqual([
      RESERVE_SCRIPT,
      3,
      'queue:email:ready',
      'queue:email:processing',
      'queue:email:jobs',
      100,
      10,
    ]);
    await queue.disconnect();
  });

  it('requeue of a job whose payload is gone sends no script', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();
    await queue.requeue('email', 'missing', 200, 1);
    expect(client.evals).toEqual([]);
    await queue.disconnect();
  });

  it('dead-letters without retention, leaving the payload in the jobs hash', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();
    await queue.enqueue(job('j1'));
    await queue.reserve('email', 10, 100);
    await queue.deadLetter('email', 'j1', 300);

    const last = client.evals.at(-1)!;
    expect(last[0]).toBe(DEAD_LETTER_SCRIPT);
    expect(last.slice(-1)).toEqual(['0']);
    expect(await client.zrangebyscore('queue:email:dead', '-inf', '+inf')).toEqual(['j1']);
    expect(await client.hget('queue:email:jobs', 'j1')).not.toBeNull();
    await queue.disconnect();
  });

  it('dead-letters with retention, moving the payload in the same script', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client, deadLetterTtlMs: 60_000 });
    await queue.connect();
    await queue.enqueue(job('j1'));
    await queue.reserve('email', 10, 100);
    await queue.deadLetter('email', 'j1', 300);

    expect(client.evals.at(-1)!.slice(-1)).toEqual(['1']);
    expect(await client.hget('queue:email:jobs', 'j1')).toBeNull();
    expect(await client.hget('queue:email:dead:jobs', 'j1')).not.toBeNull();
    expect(client.calls.some((c) => c.method === 'expire')).toBe(true);
    await queue.disconnect();
  });
});

describe('a reserve timeout the server still applies', () => {
  it('without eval, loses the job between the two sets (the fallback path)', async () => {
    const client = timeOutAfterApplying(new FakeRedisClient(), 'zrem');
    const queue = new RedisQueue({ client });
    await queue.connect();
    await queue.enqueue(job('j1'));

    await expect(queue.reserve('email', 10, 100)).rejects.toThrow('Command timed out');
    expect(await locate(client, 'j1')).toEqual({ ready: false, processing: false, payload: true });
    await queue.disconnect();
  });

  it('with eval, leaves the job whole in processing', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();
    await queue.enqueue(job('j1'));
    timeOutAfterApplying(client, 'eval');

    await expect(queue.reserve('email', 10, 100)).rejects.toThrow('Command timed out');
    expect(await locate(client, 'j1')).toEqual({ ready: false, processing: true, payload: true });
    await queue.disconnect();
  });
});
