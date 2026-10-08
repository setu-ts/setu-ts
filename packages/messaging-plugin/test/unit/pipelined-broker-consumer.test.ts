/**
 * The `consumer` dispatch identity on the messaging envelope (M109a §3.19).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIngressBehavior, IngressContext } from '@setu-ts/common';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';

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
