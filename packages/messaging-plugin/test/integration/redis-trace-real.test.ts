/** Real Redis Streams trace-header round trip, guarded by `REDIS_URL`. */
import { describe, expect, it } from 'vitest';
import type { MessageMetadata } from '@setu-ts/common';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { REDIS_CLIENTS, redisOptions } from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  describe('REAL RedisStreamsBroker trace headers (guarded)', () => {
    it.each([{}, { traceparent: TRACEPARENT, baggage: 'tenant=example' }])(
      'M75 header conformance reads back %j',
      { skip: process.env['REDIS_URL'] === undefined },
      async (headers) => {
        const topic = `m117-headers-${crypto.randomUUID()}`;
        const broker = new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
          ...redisOptions(redisVariant, process.env['REDIS_URL']!),
          pollIntervalMs: 10,
          blockSizeMs: 10,
        });
        const deliveries: MessageMetadata[] = [];
        try {
          await broker.connect();
          await broker.subscribeWithHeaders(
            topic,
            (_message, metadata) => {
              deliveries.push(metadata);
            },
            { queue: `m117-${crypto.randomUUID()}` },
          );
          await broker.publishWithHeaders(topic, { id: 1 }, headers);
          await waitFor(() => deliveries.length === 1, 3000);
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0].headers).toEqual(headers);
        } finally {
          await broker.disconnect();
        }
      },
    );
    it(
      'round-trips traceparent through XADD fields',
      {
        skip: process.env['REDIS_URL'] === undefined,
      },
      async () => {
        const url = process.env['REDIS_URL'];
        if (url === undefined) throw new Error('Backend guard failed');

        await import('ioredis');

        const broker = new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
          ...redisOptions(redisVariant, url),
          pollIntervalMs: 25,
        });
        const topic = `m75:trace:${crypto.randomUUID()}`;
        const received: MessageMetadata[] = [];

        try {
          await broker.connect();
          const subscription = await broker.subscribe(
            topic,
            (_message, metadata) => {
              received.push(metadata);
            },
            { queue: `m75-trace-${crypto.randomUUID()}` },
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          await broker.publishWithHeaders(topic, { id: 'message-1' }, { traceparent: TRACEPARENT });
          await waitFor(() => received.length === 1, 1000);

          expect(received).toHaveLength(1);
          expect(received[0]?.headers?.traceparent).toBe(TRACEPARENT);
          await subscription.unsubscribe();
        } finally {
          await broker.disconnect();
        }
      },
    );
  });
});
