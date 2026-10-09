/**
 * The `consumer` dispatch identity on the messaging envelope (M109a §3.19).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIngressBehavior, IMessageBroker, IngressContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';

/** Records every enveloped delivery and returns a live subscription. */
function fakeBroker() {
  const handlers:
    ((message: unknown, metadata: { headers?: Record<string, string> }) => void | Promise<void>)[] =
      [];
  const broker = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    reachability: () => Promise.resolve(true),
    isHealthy: () => Promise.resolve(true),
    publish: () => Promise.resolve(),
    publishWithHeaders: () => Promise.resolve(),
    subscribeWithHeaders: (
      _topic: string,
      handler: (
        message: unknown,
        metadata: { headers?: Record<string, string> },
      ) => void | Promise<void>,
    ) => {
      handlers.push(handler);
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
  };
  return { broker, handlers };
}

/** An envelope-capturing behaviour. */
function captureBehavior(envelopes: IngressContext[]): IIngressBehavior {
  return {
    handle: (ctx, next) => {
      envelopes.push(ctx);
      return next();
    },
  };
}

describe('PipelinedBroker consumer identity (M109a §3.19)', () => {
  it('uses SubscribeOptions.queue when given', async () => {
    const { broker, handlers } = fakeBroker();
    const envelopes: IngressContext[] = [];
    const pipelined = new PipelinedBroker(
      broker as never,
      [captureBehavior(envelopes)],
      undefined,
      undefined,
      'pfx',
    );
    await pipelined.subscribeWithHeaders('order.placed.v1', () => {}, { queue: 'billing' });
    await handlers[0]({}, {});
    expect(envelopes[0].consumer).toBe('billing');
  });

  it('mints two distinct per-process ids for two queue-less subscriptions', async () => {
    const { broker, handlers } = fakeBroker();
    const envelopes: IngressContext[] = [];
    const pipelined = new PipelinedBroker(
      broker as never,
      [captureBehavior(envelopes)],
      undefined,
      undefined,
      'pfx',
    );
    await pipelined.subscribeWithHeaders('t', () => {});
    await pipelined.subscribeWithHeaders('t', () => {});
    await handlers[0]({}, {});
    await handlers[1]({}, {});
    const [first, second] = envelopes.map((envelope) => envelope.consumer);
    expect(first).toBe('subscription:pfx:1');
    expect(second).toBe('subscription:pfx:2');
    expect(first).not.toBe(second);
  });

  it('carries the consumer on every delivery of one subscription', async () => {
    const { broker, handlers } = fakeBroker();
    const envelopes: IngressContext[] = [];
    const pipelined = new PipelinedBroker(
      broker as never,
      [captureBehavior(envelopes)],
      undefined,
      undefined,
      'pfx',
    );
    await pipelined.subscribeWithHeaders('t', () => {});
    await handlers[0]({}, {});
    await handlers[0]({}, {});
    expect(envelopes.map((envelope) => envelope.consumer)).toEqual([
      'subscription:pfx:1',
      'subscription:pfx:1',
    ]);
  });
});

/** Polls until `predicate` holds, or fails the test rather than hanging. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the subscription prefix is per application instance (M109a §3.19, D17)', () => {
  /** Boots an app with one queue-less subscription and returns its consumer id. */
  async function consumerOfOneApp(): Promise<string | undefined> {
    const envelopes: IngressContext[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          behaviors: [captureBehavior(envelopes)],
          subscriptions: [{ topic: 'order.placed.v1', handler: () => {} }],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      await broker.publish('order.placed.v1', { n: 1 });
      await until(() => envelopes.length === 1, 'the delivery');
      return envelopes[0]?.consumer;
    } finally {
      await app.stop();
    }
  }

  it('gives two applications different queue-less consumer ids', async () => {
    const first = await consumerOfOneApp();
    const second = await consumerOfOneApp();
    // `MessagingPlugin` passes `ctx.runtime.uuid()` as the prefix.
    expect(first).toMatch(/^subscription:[0-9a-f-]{36}:1$/);
    expect(second).toMatch(/^subscription:[0-9a-f-]{36}:1$/);
    // D17: a prefix fixed per PROCESS would make these identical, and a
    // redelivery reaching another replica would be de-duplicated against the
    // wrong consumer's record.
    expect(first).not.toBe(second);
  });
});
