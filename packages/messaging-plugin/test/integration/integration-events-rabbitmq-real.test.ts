/**
 * The integration-event envelope across a REAL transport — RabbitMQ, guarded
 * on `RABBITMQ_URL`.
 *
 * This is the only thing that proves the wire shape is transport-independent
 * rather than an artefact of the in-memory double's own `JsonSerializer`
 * round trip: every envelope field must survive a real AMQP serialization and
 * delivery with its value intact.
 *
 * The guard is `ignore:` on the `it` — an early `return` suite reports
 * PASSED while asserting nothing (M70c); an ignored suite is VISIBLE in the
 * run count.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import {
  defineIntegrationEvent,
  MessagingPlugin,
  onIntegrationEvent,
  publishIntegrationEvent,
} from '../../src/index.ts';
import type { IntegrationEventEnvelope } from '../../src/index.ts';

const rabbitUrl = Deno.env.get('RABBITMQ_URL');

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe('REAL RabbitMQ integration events (guarded on RABBITMQ_URL)', () => {
  it('delivers every envelope field through publishIntegrationEvent and onIntegrationEvent', {
    ignore: rabbitUrl === undefined,
  }, async () => {
    // A unique topic per run AND the `.v1` suffix the definition guard
    // requires: `...<suffix>.v1` ends with the exact string `.v1`.
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const topic = `m93b.orders.placed.${suffix}.v1`;
    const definition = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic,
      parse: (value) => value as { orderId: string },
    });
    const deliveries: IntegrationEventEnvelope<{ orderId: string }>[] = [];

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'rabbitmq',
          url: rabbitUrl!,
          subscriptions: [
            onIntegrationEvent(definition, (_payload, envelope) => {
              deliveries.push(envelope);
            }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      await publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' }, {
        correlationId: 'root-9',
        causationId: 'e-8',
        aggregateId: 'order-1',
        aggregateVersion: 4,
      });

      await waitFor(() => deliveries.length === 1, 'the real RabbitMQ delivery');
      const envelope = deliveries[0];
      expect(typeof envelope.id).toBe('string');
      expect(envelope.id.length).toBeGreaterThan(0);
      expect(envelope.type).toBe('orders.placed');
      expect(envelope.version).toBe(1);
      expect(envelope.data).toEqual({ orderId: 'o-1' });
      // The ISO-8601 string timestamp survives the real transport as a
      // string that still parses as an instant.
      expect(Number.isNaN(Date.parse(envelope.occurredAt))).toBe(false);
      expect(envelope.correlationId).toBe('root-9');
      expect(envelope.causationId).toBe('e-8');
      expect(envelope.aggregateId).toBe('order-1');
      expect(envelope.aggregateVersion).toBe(4);
    } finally {
      await app.stop();
    }
  });
});
