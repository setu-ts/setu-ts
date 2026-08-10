/**
 * The `messaging` arm driven through a real kernel application, so the token is
 * registered and resolved exactly as an application resolves it.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  HealthCheckResult,
  IApplication,
  ILogger,
  IMessageBroker,
  IPlugin,
} from '@setu-ts/common';

import {
  CloudflareBindingMissingError,
  CloudflarePlugin,
  CloudflareUnsupportedError,
  WorkersBroker,
} from '../../src/index.ts';
import { FakeDurableObjectNamespace } from '../do-fakes.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer, RecordingLogger } from '../fakes.ts';
import { encodePublishEnvelope } from '../../src/messaging/message-envelope.ts';

/**
 * Runs a named health indicator the way `health-plugin` would.
 *
 * `ctx.health.register` stores each indicator as a multi-provider entry under
 * `CAPABILITIES.HEALTH_INDICATOR`, so reading them back out of the registry
 * exercises the real registration path rather than a patched method.
 */
async function checkHealth(app: IApplication, name: string): Promise<HealthCheckResult> {
  const indicators = app.services.getAll<{ name: string; check: () => Promise<HealthCheckResult> }>(
    CAPABILITIES.HEALTH_INDICATOR,
  );
  const indicator = indicators.find((entry) => entry.name === name);
  if (indicator === undefined) {
    throw new Error(`no indicator named '${name}'`);
  }
  return await indicator.check();
}

/** Lets a lazily opened inbox settle. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('CloudflarePlugin messaging arm', () => {
  it('registers a WorkersBroker under the bare messaging token', async () => {
    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({ env: { MESSAGES: producer }, messaging: { binding: 'MESSAGES' } }),
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeInstanceOf(WorkersBroker);

    await broker.publish('orders', { id: 1 });
    expect(producer.sends).toHaveLength(1);

    await app.stop();
  });

  it('derives messaging.<name> for a named instance, so two can coexist', async () => {
    const orders = new FakeQueueProducer();
    const billing = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { ORDERS: orders },
          messaging: { binding: 'ORDERS', name: 'orders' },
        }),
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>('messaging.orders');
    await broker.publish('t', 1);

    expect(orders.sends).toHaveLength(1);
    expect(billing.sends).toHaveLength(0);
    // The bare token is NOT claimed by a named instance.
    expect(() => app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING)).toThrow();

    await app.stop();
  });

  it('registers nothing when the arm is omitted', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin({ env: {} }), CloudflarePlugin({ env: {} })],
    });
    await app.start();

    expect(() => app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING)).toThrow();

    await app.stop();
  });

  it('throws at register() when the queue binding is absent', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({ env: {}, messaging: { binding: 'MESSAGES' } }),
      ],
    });

    await expect(app.start()).rejects.toThrow(CloudflareBindingMissingError);
  });

  it('throws at register() when the queue binding has the wrong shape', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        // A KV-shaped binding under the queue name — a `wrangler.toml` typo.
        // Without the shape guard this booted clean and failed on the first
        // publish with a bare TypeError pointing at nothing.
        CloudflarePlugin({
          env: { MESSAGES: { get: () => {}, put: () => {}, delete: () => {}, list: () => {} } },
          messaging: { binding: 'MESSAGES' },
        }),
      ],
    });

    // Captured once rather than asserted twice: a second `start()` re-registers
    // the runtime capability and would fail on that instead, hiding this.
    const error = await app.start().then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(CloudflareBindingMissingError);
    expect(String(error)).toContain('a Queues producer');
  });

  it('throws at register() when the rpc binding is not a Durable Object namespace', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { MESSAGES: new FakeQueueProducer(), INBOX: { notANamespace: true } },
          messaging: { binding: 'MESSAGES', rpc: { binding: 'INBOX' } },
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow('a Durable Object namespace');
  });

  it('refuses request() without the rpc arm, naming the fix', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { MESSAGES: new FakeQueueProducer() },
          messaging: { binding: 'MESSAGES' },
        }),
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    await expect(broker.request('sum', 1)).rejects.toThrow(CloudflareUnsupportedError);

    await app.stop();
  });

  it('reports the arm in the cloudflare health indicator', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { MESSAGES: new FakeQueueProducer(), INBOX: new FakeDurableObjectNamespace() },
          messaging: { binding: 'MESSAGES', rpc: { binding: 'INBOX' } },
        }),
      ],
    });
    await app.start();

    const health = await checkHealth(app, 'cloudflare');

    expect(health.data?.messaging).toBe(true);
    expect(health.data?.rpc).toBe(true);

    await app.stop();
  });

  it('reports rpc false when only the queue half is configured', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { MESSAGES: new FakeQueueProducer() },
          messaging: { binding: 'MESSAGES' },
        }),
      ],
    });
    await app.start();

    const health = await checkHealth(app, 'cloudflare');

    expect(health.data?.messaging).toBe(true);
    expect(health.data?.rpc).toBe(false);

    await app.stop();
  });

  it('disconnects the broker on shutdown, failing an in-flight request', async () => {
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { MESSAGES: new FakeQueueProducer(), INBOX: namespace },
          messaging: { binding: 'MESSAGES', rpc: { binding: 'INBOX' } },
        }),
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    const pending = broker.request('sum', 1, { timeoutMs: 60_000 });
    await flush();

    await app.stop();

    // Without the onShutdown hook this promise stays pending for the full
    // budget and the socket to the Durable Object is never closed.
    await expect(pending).rejects.toThrow('disconnected');
    expect(namespace.clients[0]?.closed).toBe(true);
  });

  it('reports a dispatch failure through a logger registered AFTER it', async () => {
    // The kernel resolves ctx.logger lazily and a capability may be registered
    // imperatively, with no `provides` for the resolver to order against.
    // Capturing the value at register() would silence every dispatch report —
    // the defect M52 fixed on the waitUntil seam and M52b on the queue's.
    const logger = new RecordingLogger();
    const lateLogger: IPlugin = {
      name: 'late-logger',
      version: '0.0.0',
      register(ctx): void {
        ctx.services.register(CAPABILITIES.LOGGER, logger as ILogger);
      },
    };

    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({
          env: { MESSAGES: new FakeQueueProducer() },
          messaging: { binding: 'MESSAGES' },
        }),
        lateLogger,
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    // A body no producer of ours wrote: the report is the only signal.
    await (broker as WorkersBroker).dispatch(
      new FakeQueueBatch('messages', [new FakeQueueMessage('m1', { foreign: true })]),
    );

    expect(logger.messages()).toEqual([
      'cloudflare-messaging: message not readable, retried',
    ]);

    await app.stop();
  });

  it('delivers a published message back through a dispatched batch', async () => {
    const producer = new FakeQueueProducer();
    const app = createApplication({
      plugins: [
        RuntimePlugin({ env: {} }),
        CloudflarePlugin({ env: { MESSAGES: producer }, messaging: { binding: 'MESSAGES' } }),
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    const seen: unknown[] = [];
    await broker.subscribe<{ id: number }>('orders', (message) => {
      seen.push(message);
    });

    await broker.publish('orders', { id: 7 });

    // The platform round trip, as the `queue` export drives it: what the
    // producer accepted is what comes back in a batch.
    const message = new FakeQueueMessage('m1', producer.sends[0]?.body);
    await (broker as WorkersBroker).dispatch(new FakeQueueBatch('messages', [message]));

    expect(seen).toEqual([{ id: 7 }]);
    expect(message.disposition).toBe('acked');
    // Written through the real encoder, so the wire shape is the one asserted
    // rather than a hand-copied literal that could drift from it.
    const sent = producer.sends[0]?.body as { readonly id: string };
    expect(sent).toEqual({ ...encodePublishEnvelope('orders', sent.id, { id: 7 }) });

    await app.stop();
  });
});
