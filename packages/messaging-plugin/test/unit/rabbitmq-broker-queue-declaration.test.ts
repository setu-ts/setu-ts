/**
 * X10-1: the queue declaration carries the intent the subscription's shape
 * already encodes.
 *
 * RabbitMQ 4 refuses the old unconditional `{ durable: false }` for a named,
 * non-exclusive queue (`541 INTERNAL-ERROR … transient_nonexcl_queues`). The
 * broker already computed `isExclusive` at subscribe time — it simply never
 * passed it to `assertQueue`. These tests pin the two shapes on a recording
 * fake channel: durable for a caller-supplied consumer-group queue, transient
 * (exclusive + autoDelete) for a private per-subscriber queue AND for the RPC
 * reply inbox, whose per-instance address must never become a durable queue.
 *
 * The branching AROUND which options object is built is what these tests
 * cover; the guarded real-import path against an actual RabbitMQ 4 server
 * lives in `test/integration/rabbitmq-v4-declaration.test.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';

/** Wires a broker over a fake connection and connects it. */
function setup() {
  const runtime = createFakeRuntime();
  const connection = new FakeAmqpConnection();
  const broker = new RabbitMqBroker(runtime, new JsonSerializer(), { client: connection });
  return { broker, connection };
}

describe('RabbitMqBroker queue declaration (X10-1)', () => {
  it('declares a caller-supplied consumer-group queue DURABLE', async () => {
    const { broker, connection } = setup();
    await broker.connect();

    await broker.subscribe('orders.created', () => {}, { queue: 'order-processors' });

    const channel = await connection.createChannel();
    const call = channel.calls.find(
      (c) => c.method === 'assertQueue' && c.args[0] === 'order-processors',
    );
    expect(call).toBeDefined();
    // A consumer group survives a broker restart — that is what `queue`
    // documents, and RabbitMQ 4 refuses anything less exclusive-shaped.
    expect(call?.args[1]).toEqual({ durable: true });

    await broker.disconnect();
  });

  it('declares a USER queue named rr.inbox.* as a normal durable group queue (F3)', async () => {
    // F3 regression: transience was detected by pattern-matching queue
    // names against the internal `rr.inbox.` prefix, so a legitimate
    // consumer group named e.g. `rr.inbox.orders` was made
    // `{ exclusive: true, autoDelete: true }` and non-durable — a second
    // instance's use of it was refused by RabbitMQ. The marker now travels
    // on the internal subscribe call, so any user-supplied queue name,
    // whatever it starts with, is declared as a durable group queue.
    const { broker, connection } = setup();
    await broker.connect();

    await broker.subscribe('orders.created', () => {}, { queue: 'rr.inbox.orders' });

    const channel = await connection.createChannel();
    const call = channel.calls.find(
      (c) => c.method === 'assertQueue' && c.args[0] === 'rr.inbox.orders',
    );
    expect(call).toBeDefined();
    expect(call?.args[1]).toEqual({ durable: true });
    expect(call?.args[1]).not.toHaveProperty('exclusive');
    expect(call?.args[1]).not.toHaveProperty('autoDelete');

    await broker.disconnect();
  });

  it('declares a private per-subscriber queue EXCLUSIVE + auto-delete', async () => {
    const { broker, connection } = setup();
    await broker.connect();

    // No queue option: the broker mints a private per-subscriber queue.
    await broker.subscribe('orders.created', () => {});

    const channel = await connection.createChannel();
    const assertCalls = channel.calls.filter((c) => c.method === 'assertQueue');
    expect(assertCalls.length).toBe(1);
    expect(String(assertCalls[0]?.args[0])).not.toBe('order-processors');
    expect(assertCalls[0]?.args[1]).toEqual({ exclusive: true, autoDelete: true });

    await broker.disconnect();
  });

  it('never makes the RPC reply inbox durable', async () => {
    const { broker, connection } = setup();
    await broker.connect();
    const channel = await connection.createChannel();

    // Fire a request without awaiting: opening the inbox asserts its queue,
    // then the request waits for a reply that never comes in this test.
    const pending = broker.request('rpc.topic', { ping: true }).catch(() => undefined);

    // Poll until the inbox assertion shows up.
    let inboxCall: { method: string; args: unknown[] } | undefined;
    for (let i = 0; i < 50 && inboxCall === undefined; i++) {
      inboxCall = channel.calls.find(
        (c) => c.method === 'assertQueue' && String(c.args[0]).startsWith('rr.inbox.'),
      );
      if (inboxCall === undefined) await new Promise((r) => setTimeout(r, 5));
    }

    expect(inboxCall).toBeDefined();
    // The naive "named ⇒ durable" rule would leak ONE DURABLE REPLY QUEUE PER
    // INSTANCE here — the inbox address IS a queue name, and it is unique per
    // open. It must be transient.
    expect(inboxCall?.args[1]).toEqual({ exclusive: true, autoDelete: true });

    await pending;
    await broker.disconnect();
  });
});
