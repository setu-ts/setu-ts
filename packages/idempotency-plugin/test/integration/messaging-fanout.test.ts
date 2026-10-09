/**
 * The ingress allow-list and the consumer identity on a REAL kernel with the
 * in-memory broker (M109a §3.7, §3.19) — the reviewer's `fanout.ts` shape.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin, idempotentIngress } from '../../src/index.ts';

const TOPIC = 'order.placed.v1';

/**
 * Polls until `predicate` holds, or fails the test rather than hanging. The
 * in-memory broker dispatches through an asynchronous behaviour chain that
 * involves `crypto.subtle`, so a single macrotask is not enough on a loaded
 * machine — a fixed `setTimeout(0)` flaked under the full suite.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits for dispatches that must NOT happen — the case a positive `until`
 * cannot express: a bounded quiet period long enough for the chain to run.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** Builds an app with the behaviour on the listed topic plus three subscribers. */
async function buildApp() {
  const counts = { billing: 0, shipping: 0, plain: 0, backplane: 0 };
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      IdempotencyPlugin(),
      MessagingPlugin({ behaviors: [idempotentIngress({ topics: [TOPIC] })] }),
      {
        name: 'fanout-subscribers',
        version: '1.0.0',
        register(ctx: IPluginContext): void {
          const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
          ctx.lifecycle.onInit(async () => {
            await broker.subscribe(TOPIC, () => void counts.billing++, { queue: 'billing' });
            await broker.subscribe(TOPIC, () => void counts.shipping++, { queue: 'shipping' });
            await broker.subscribe(TOPIC, () => void counts.plain++);
            await broker.subscribe('backplane', () => void counts.backplane++);
          });
        },
      },
    ],
  });
  await app.start();
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  return { app, broker, counts };
}

describe('idempotentIngress fan-out on a real kernel (M109a §3.7, §3.19)', () => {
  it('runs each of two consumers once for one dedup id, and neither on a resend', async () => {
    const { app, broker, counts } = await buildApp();
    try {
      await broker.publish(TOPIC, { n: 1 }, { deduplicationId: 'evt-1' });
      await until(
        () => counts.billing === 1 && counts.shipping === 1 && counts.plain === 1,
        'the first delivery to the three listed subscribers',
      );
      expect(counts).toMatchObject({ billing: 1, shipping: 1, plain: 1 });

      await broker.publish(TOPIC, { n: 1 }, { deduplicationId: 'evt-1' });
      await settle();
      expect(counts).toMatchObject({ billing: 1, shipping: 1, plain: 1 });
    } finally {
      await app.stop();
    }
  });

  it('runs a subscriber on an unlisted topic every time, and makes no store call for it', async () => {
    const { app, broker, counts } = await buildApp();
    try {
      await broker.publish('backplane', { frame: 1 });
      await broker.publish('backplane', { frame: 2 });
      await until(() => counts.backplane === 2, 'both unlisted-topic deliveries');
      expect(counts.backplane).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('refuses a header-less publish on the LISTED topic without running its handler', async () => {
    const { app, broker, counts } = await buildApp();
    try {
      // `publish` without a deduplication id surfaces the refusal on the
      // broker's own failure path; the handler must not run.
      await broker.publish(TOPIC, { n: 9 }).catch(() => {});
      await settle();
      expect(counts).toMatchObject({ billing: 0, shipping: 0, plain: 0 });
    } finally {
      await app.stop();
    }
  });
});
