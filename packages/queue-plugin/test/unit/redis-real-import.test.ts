// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * Guarded real-import test: RedisQueue enqueue→reserve→ack round trip against a live Redis.
 *
 * Guard: requires REDIS_URL env and npm:ioredis@5.x presence. When either is
 * absent, logs SKIP and returns. When present, constructs RedisQueue with NO
 * injected client so the production loadIoredis path runs for real.
 *
 * This is ROADMAP deliverable 5 — the deepened guarded test that proves the
 * ZRANGEBYSCORE LIMIT fix works against a real Redis server.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';

describe('REAL RedisQueue round trip (guarded)', () => {
  it('enqueue → reserve → ack round trip against live Redis', async () => {
    const url = Deno.env.get('REDIS_URL');
    if (url === undefined) {
      console.log('SKIP: REDIS_URL not set');
      return;
    }

    let ioredisPresent = false;
    try {
      await import('npm:ioredis@5.x');
      ioredisPresent = true;
    } catch {
      // npm:ioredis not available
    }
    if (!ioredisPresent) {
      console.log('SKIP: npm:ioredis@5.x not available');
      return;
    }

    const queueName = `m53:${crypto.randomUUID()}`;
    const queue = new RedisQueue({ url });

    try {
      await queue.connect();
      expect(queue.isReady()).toBe(true);

      const jobId = `job-${crypto.randomUUID()}`;
      const now = Date.now();

      // Enqueue a job
      await queue.enqueue({
        id: jobId,
        name: queueName,
        data: { hello: 'world' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      });

      // Reserve it
      const reserved = await queue.reserve(queueName, 1, now);
      expect(reserved.length).toBe(1);
      expect(reserved[0].id).toBe(jobId);
      expect(reserved[0].data).toEqual({ hello: 'world' });

      // Ack it
      await queue.ack(queueName, jobId);

      // Reserve again — should be empty now
      const reservedAgain = await queue.reserve(queueName, 1, now);
      expect(reservedAgain.length).toBe(0);
    } finally {
      await queue.disconnect();
    }
  });
});
