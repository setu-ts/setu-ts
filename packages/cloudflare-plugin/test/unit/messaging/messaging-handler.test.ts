/**
 * The `queue` export. Its two load-bearing properties are that resolution is
 * LAZY (the export is built before `app.start()` has registered anything) and
 * that a wrong service under the token REJECTS rather than throwing
 * synchronously — the application assigns this straight to a module export.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IApplication, IMessageBroker, IServiceRegistry } from '@setu-ts/common';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { createMessagingHandler } from '../../../src/messaging/messaging-handler.ts';
import { encodePublishEnvelope } from '../../../src/messaging/message-envelope.ts';
import { WorkersBroker } from '../../../src/messaging/workers-broker.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer } from '../../fakes.ts';
import { FakeBrokerRuntime } from '../../messaging-fakes.ts';

/** An application whose registry answers from a map filled in later. */
function appWith(services: Map<string, unknown>): { app: IApplication; reads: string[] } {
  const reads: string[] = [];
  const registry = {
    get: <T>(token: string): T => {
      reads.push(token);
      const service = services.get(token);
      if (service === undefined) throw new Error(`No service registered under '${token}'`);
      return service as T;
    },
  } as unknown as IServiceRegistry;
  return { app: { services: registry } as unknown as IApplication, reads };
}

describe('createMessagingHandler', () => {
  it('resolves the bare messaging token and dispatches into the broker', async () => {
    const services = new Map<string, unknown>();
    const { app, reads } = appWith(services);
    const handler = createMessagingHandler(app);

    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());
    const seen: unknown[] = [];
    await broker.subscribe('orders', (message) => {
      seen.push(message);
    });
    // Registered AFTER the export was built — the lazy-resolution property.
    services.set('messaging', broker);

    const message = new FakeQueueMessage('m1', encodePublishEnvelope('orders', 'i1', 'payload'));
    await handler(new FakeQueueBatch('messages', [message]));

    expect(reads).toEqual(['messaging']);
    expect(seen).toEqual(['payload']);
    expect(message.disposition).toBe('acked');
  });

  it('resolves a named instance token', async () => {
    const services = new Map<string, unknown>();
    const { app, reads } = appWith(services);
    const handler = createMessagingHandler(app, { name: 'orders' });
    services.set(
      'messaging.orders',
      new WorkersBroker(
        new FakeQueueProducer(),
        new FakeBrokerRuntime(),
      ),
    );

    await handler(new FakeQueueBatch('messages', []));

    expect(reads).toEqual(['messaging.orders']);
  });

  it("treats name 'default' as the bare token", async () => {
    const services = new Map<string, unknown>();
    const { app, reads } = appWith(services);
    const handler = createMessagingHandler(app, { name: 'default' });
    services.set('messaging', new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime()));

    await handler(new FakeQueueBatch('messages', []));

    expect(reads).toEqual(['messaging']);
  });

  it('resolves on every invocation, not once at build time', async () => {
    const services = new Map<string, unknown>();
    const { app, reads } = appWith(services);
    const handler = createMessagingHandler(app);
    services.set('messaging', new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime()));

    await handler(new FakeQueueBatch('messages', []));
    await handler(new FakeQueueBatch('messages', []));

    expect(reads).toEqual(['messaging', 'messaging']);
  });

  it('REJECTS rather than throwing when another broker holds the token', async () => {
    const services = new Map<string, unknown>();
    const { app } = appWith(services);
    const handler = createMessagingHandler(app);
    // An in-memory broker satisfies IMessageBroker but has no batch to
    // dispatch, so this would otherwise present as messages vanishing.
    services.set('messaging', { publish: () => Promise.resolve() } as unknown as IMessageBroker);

    const settled = handler(new FakeQueueBatch('messages', []));

    // `handler(...)` must not have thrown synchronously: the application
    // assigns it straight to its `queue` export, where a caller writing
    // `queue: (b) => handler(b).catch(report)` would not catch a throw.
    expect(settled).toBeInstanceOf(Promise);
    await expect(settled).rejects.toThrow(CloudflareUnsupportedError);
    await expect(handler(new FakeQueueBatch('messages', []))).rejects.toThrow(
      'not a WorkersBroker',
    );
  });

  it('REJECTS rather than throwing when the token holds nothing', async () => {
    const { app } = appWith(new Map());
    const handler = createMessagingHandler(app);

    const settled = handler(new FakeQueueBatch('messages', []));

    expect(settled).toBeInstanceOf(Promise);
    await expect(settled).rejects.toThrow("No service registered under 'messaging'");
  });
});
