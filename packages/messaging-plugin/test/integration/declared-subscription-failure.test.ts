/**
 * A declared subscription that rejects must not leak the connected broker
 * (M101b review).
 *
 * M101b makes a declared subscription reject `start()` on purpose —
 * `KafkaTopicUnavailableError`, `PubSubSubscriptionBoundElsewhereError`,
 * `NatsConsumerNameCollisionError`. `MessagingPlugin.register()` connected the
 * broker, subscribed the declared entries, and only THEN registered its
 * `onClose` hook — so on exactly that path no hook existed, the kernel's
 * failed-start cleanup had nothing to run, and the connected broker stayed
 * open. Against a real Kafka broker the process never exited (measured). The
 * hook is now registered right after `connect()`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';

describe('MessagingPlugin with a declared subscription that rejects', () => {
  it('closes the connected broker when start() fails', async () => {
    const calls: string[] = [];
    const refusal = new Error('the broker refused this subscription');
    const instance = {
      connect: () => {
        calls.push('connect');
        return Promise.resolve();
      },
      disconnect: () => {
        calls.push('disconnect');
        return Promise.resolve();
      },
      publish: () => Promise.resolve(),
      subscribe: () => {
        calls.push('subscribe');
        return Promise.reject(refusal);
      },
      request: () => Promise.reject(new Error('unused')),
      respond: () => Promise.reject(new Error('unused')),
    } as unknown as IMessageBroker;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'custom',
          instance,
          subscriptions: [{ topic: 'orders', handler: () => {} }],
        }),
      ],
    });

    const err = await app.start().then(() => null, (e: unknown) => e);

    expect(err).toBe(refusal);
    // Connected, refused, and then CLOSED by the kernel's failed-start
    // cleanup — exactly once.
    expect(calls).toEqual(['connect', 'subscribe', 'disconnect']);
  });
});
