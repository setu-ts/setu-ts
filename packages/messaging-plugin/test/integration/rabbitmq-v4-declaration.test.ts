// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * X10-1's real-backend gate: the queue declaration against an actual
 * RabbitMQ **4** server.
 *
 * RabbitMQ 4 refuses the pre-M70l unconditional `{ durable: false }` named
 * non-exclusive declaration with `541 INTERNAL-ERROR … transient_nonexcl_queues`
 * — a failure NO fake can reproduce, because the recording fakes accept any
 * options object. This suite is therefore guarded on `RABBITMQ_URL` (M53
 * pattern) and is the only place §3.1 is decidable end to end. CI runs it
 * against a `rabbitmq:4-management-alpine` service container; locally:
 *
 * ```bash
 * docker run -d --name m70l-rabbit -p 5672:5672 rabbitmq:4-management-alpine
 * RABBITMQ_URL=amqp://localhost:5672 deno task test
 * ```
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MessageMetadata } from '@setu-ts/common';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('RabbitMqBroker against RabbitMQ 4 (X10-1)', () => {
  it('a group subscriber and a private subscriber both receive a published message', async () => {
    const url = Deno.env.get('RABBITMQ_URL');
    if (url === undefined) {
      console.log('SKIP: RABBITMQ_URL not set');
      return;
    }

    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      url,
      // A unique exchange per run so concurrent suites never cross-talk.
      exchangeName: `m70l-decl-${crypto.randomUUID()}`,
    });
    await broker.connect();

    const received: string[] = [];
    const group = await broker.subscribe(
      'm70l.declaration',
      (message: unknown, _meta: MessageMetadata) => {
        received.push((message as { kind: string }).kind);
      },
      { queue: `m70l-group-${crypto.randomUUID()}` }, // durable consumer-group shape
    );
    const priv = await broker.subscribe(
      'm70l.declaration',
      (message: unknown, _meta: MessageMetadata) => {
        received.push((message as { kind: string }).kind);
      }, // private per-subscriber queue: exclusive + autoDelete
    );

    // Let the subscriptions settle server-side before publishing.
    await new Promise((r) => setTimeout(r, 200));
    await broker.publish('m70l.declaration', { kind: 'both' });
    await new Promise((r) => setTimeout(r, 300));

    expect(received.sort()).toEqual(['both', 'both']);

    await group.unsubscribe();
    await priv.unsubscribe();
    await broker.disconnect();
  });

  it('completes an RPC round trip', async () => {
    const url = Deno.env.get('RABBITMQ_URL');
    if (url === undefined) {
      console.log('SKIP: RABBITMQ_URL not set');
      return;
    }

    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      url,
      exchangeName: `m70l-rpc-${crypto.randomUUID()}`,
    });
    await broker.connect();

    await broker.respond<{ ping: number }, { pong: number }>(
      'm70l.rpc',
      (request) => Promise.resolve({ pong: request.ping + 1 }),
    );
    await new Promise((r) => setTimeout(r, 200));

    const reply = await broker.request<{ ping: number }, { pong: number }>(
      'm70l.rpc',
      { ping: 41 },
    );
    expect(reply).toEqual({ pong: 42 });

    await broker.disconnect();
  });
});
