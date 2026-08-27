// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/** Real Redis Streams trace-header round trip, guarded by `REDIS_URL`. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MessageMetadata } from '@setu-ts/common';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('REAL RedisStreamsBroker trace headers (guarded)', () => {
  it('round-trips traceparent through XADD fields', async () => {
    const url = Deno.env.get('REDIS_URL');
    if (url === undefined) {
      console.log('SKIP: REDIS_URL not set');
      return;
    }

    try {
      await import('npm:ioredis@5.x');
    } catch {
      console.log('SKIP: npm:ioredis@5.x not available');
      return;
    }

    const broker = new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
      url,
      pollIntervalMs: 25,
    });
    const topic = `m75:trace:${crypto.randomUUID()}`;
    const received: MessageMetadata[] = [];

    try {
      await broker.connect();
      const subscription = await broker.subscribe(topic, (_message, metadata) => {
        received.push(metadata);
      }, { queue: `m75-trace-${crypto.randomUUID()}` });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await broker.publishWithHeaders(topic, { id: 'message-1' }, { traceparent: TRACEPARENT });
      await waitFor(() => received.length === 1, 1000);

      expect(received).toHaveLength(1);
      expect(received[0]?.headers?.traceparent).toBe(TRACEPARENT);
      await subscription.unsubscribe();
    } finally {
      await broker.disconnect();
    }
  });
});
