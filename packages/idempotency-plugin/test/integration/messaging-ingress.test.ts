/**
 * `idempotentIngress` over an INTEGRATION EVENT on a real kernel (plan §3.7,
 * §6): `publishIntegrationEvent` defaults the deduplication id to the envelope
 * id, and that id reaches the consumer as the `x-setu-deduplication-id`
 * header — which is the messaging arm's default key source. So two publishes
 * carrying the SAME `deduplicationId` run the consumer once.
 *
 * The raw `publish` + `deduplicationId` half of the plan's row is covered by
 * `messaging-fanout.test.ts` ("runs each of two consumers once for one dedup
 * id, and neither on a resend"); this file covers the integration-event path
 * that goes through the contract layer.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, IPluginContext, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  defineIntegrationEvent,
  MessagingPlugin,
  publishIntegrationEvent,
} from '@setu-ts/messaging-plugin';
import { IdempotencyPlugin, idempotentIngress } from '../../src/index.ts';

const TOPIC = 'order.placed.v1';

/** The contract the consumer is registered against. */
const orderPlaced = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: TOPIC,
  parse: (value) => value as { orderId: string },
});

/** Polls until `predicate` holds, or fails the test rather than hanging. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits for a delivery that must NOT happen. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

describe('idempotentIngress on an integration event (M109a §3.7)', () => {
  it('runs the consumer once for two publishes sharing a deduplication id', async () => {
    let delivered = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin(),
        MessagingPlugin({ behaviors: [idempotentIngress({ topics: [TOPIC] })] }),
        {
          name: 'integration-event-consumer',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
            ctx.lifecycle.onInit(async () => {
              await broker.subscribe(TOPIC, () => void delivered++, { queue: 'billing' });
            });
          },
        },
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

      await publishIntegrationEvent(runtime, broker, orderPlaced, { orderId: '1' }, undefined, {
        deduplicationId: 'evt-1',
      });
      await until(() => delivered === 1, 'the first integration event to be consumed');

      // The same deduplication id again is answered from the completed record.
      await publishIntegrationEvent(runtime, broker, orderPlaced, { orderId: '1' }, undefined, {
        deduplicationId: 'evt-1',
      });
      await settle();
      expect(delivered).toBe(1);

      // A different id is a different key and runs.
      await publishIntegrationEvent(runtime, broker, orderPlaced, { orderId: '2' }, undefined, {
        deduplicationId: 'evt-2',
      });
      await until(() => delivered === 2, 'the second integration event to be consumed');
      expect(delivered).toBe(2);
    } finally {
      await app.stop();
    }
  });
});
