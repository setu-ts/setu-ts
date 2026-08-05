// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * Guarded real-import test: RedisStreamsBroker publish→subscribe round trip against a live Redis.
 *
 * Guard: requires REDIS_URL env and npm:ioredis@5.x presence. When either is
 * absent, logs SKIP and returns. When present, constructs RedisStreamsBroker
 * with NO injected client so the production loadIoredis path runs for real.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('REAL RedisStreamsBroker round trip (guarded)', () => {
  it('publish → subscribe round trip against live Redis', async () => {
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

    const runtime: IRuntimeServices = createFakeRuntime();
    const serializer = new JsonSerializer();
    const topic = `m53:${crypto.randomUUID()}`;
    const queue = `m53-queue-${crypto.randomUUID()}`;

    const broker = new RedisStreamsBroker(runtime, serializer, {
      url,
      pollIntervalMs: 50,
    });

    try {
      await broker.connect();
      expect(broker.isReady()).toBe(true);

      const received: unknown[] = [];
      await broker.subscribe(topic, (msg) => {
        received.push(msg);
        return Promise.resolve();
      }, { queue });

      // Allow subscription to initialize before publishing
      await new Promise((r) => setTimeout(r, 100));

      await broker.publish(topic, { hello: 'world' });

      // Wait for poll interval to deliver the message
      await new Promise((r) => setTimeout(r, 200));

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]).toEqual({ hello: 'world' });
    } finally {
      await broker.disconnect();
    }
  });
});
