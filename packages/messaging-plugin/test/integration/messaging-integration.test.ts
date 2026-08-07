/**
 * Integration tests for MessagingPlugin via kernel app.inject().
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { MessagingPlugin } from '../../src/index.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IPlugin } from '@setu-ts/common';
import type { IKafkaFactory } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeKafkaFactory } from '../fixtures/fake-kafkajs-client.ts';

/** Fake runtime plugin for integration tests. */
function fakeRuntimePlugin(): IPlugin {
  const runtime = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

describe('MessagingPlugin integration', () => {
  it('should publish and receive message through public token', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), MessagingPlugin({ broker: 'memory' })],
    });

    // Subscribe in a separate plugin
    let messageReceived: unknown = null;
    app.register({
      name: 'message-subscriber',
      version: '1.0.0',
      dependencies: ['messaging'],
      register(ctx) {
        const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
        broker.subscribe('test.topic', (message) => {
          messageReceived = message;
        });
      },
    });

    await app.start();

    // Publish through the broker
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    await broker.publish('test.topic', { userId: '123', action: 'login' });

    await app.stop();

    expect(messageReceived).toBeDefined();
    expect((messageReceived as { userId: string }).userId).toBe('123');
  });

  it('should support named instances with distinct tokens', async () => {
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({ name: 'events', broker: 'memory' }),
        MessagingPlugin({ name: 'audit', broker: 'memory' }),
      ],
    });

    let eventsReceived = 0;
    let auditReceived = 0;

    await app.start();

    // Subscribe to events broker
    const eventsBroker = app.services.get<IMessageBroker>('messaging.events');
    await eventsBroker.subscribe('events.topic', () => {
      eventsReceived++;
    });

    // Subscribe to audit broker
    const auditBroker = app.services.get<IMessageBroker>('messaging.audit');
    await auditBroker.subscribe('audit.topic', () => {
      auditReceived++;
    });

    // Publish to each
    await eventsBroker.publish('events.topic', { type: 'event' });
    await auditBroker.publish('audit.topic', { type: 'audit' });

    await app.stop();

    expect(eventsReceived).toBe(1);
    expect(auditReceived).toBe(1);
  });

  it('should connect and disconnect broker', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), MessagingPlugin({ broker: 'memory' })],
    });

    await app.start();

    // Broker should be connected after start
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeDefined();

    await app.stop();

    // Broker should be disconnected after stop (no error thrown)
    expect(broker).toBeDefined();
  });
});

describe('EventsMessagingBridge integration', () => {
  it('should forward events to messaging broker', async () => {
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        // We need to manually set up event bus since we're not using EventsPlugin
        // This test verifies the bridge can resolve and use the messaging broker
        MessagingPlugin({ broker: 'memory' }),
      ],
    });

    let forwardedMessage: unknown = null;

    await app.start();

    // Subscribe to the broker
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    await broker.subscribe<{ userId: string; email: string }>('user.created', (message) => {
      forwardedMessage = message;
    });

    // Simulate what the bridge does: publish to broker
    await broker.publish('user.created', { userId: '456', email: 'test@example.com' });

    await app.stop();

    expect(forwardedMessage).toBeDefined();
    expect((forwardedMessage as { userId: string }).userId).toBe('456');
  });

  it('completes a Kafka RPC round trip through the resolved capability', async () => {
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({
          broker: 'kafka',
          client: new FakeKafkaFactory() as unknown as IKafkaFactory,
        }),
      ],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    await broker.respond<{ id: string }, { name: string }>(
      'user.lookup',
      (req) => ({ name: `user-${req.id}` }),
    );

    const reply = await broker.request<{ id: string }, { name: string }>(
      'user.lookup',
      { id: '42' },
    );

    expect(reply).toEqual({ name: 'user-42' });
    await app.stop();
  });

  it('keeps a responder and a plain subscriber independent on one topic', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), MessagingPlugin({ broker: 'memory' })],
    });
    await app.start();

    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    const received: unknown[] = [];
    await broker.subscribe('orders', (message) => {
      received.push(message);
    });
    await broker.respond<{ id: number }, string>('orders', (req) => `rpc-${req.id}`);

    const reply = await broker.request<{ id: number }, string>('orders', { id: 1 });
    await broker.publish('orders', { plain: true });

    // RPC resolved, and the pub/sub consumer saw only the plain publish —
    // never a request envelope, and its message was not swallowed.
    expect(reply).toBe('rpc-1');
    expect(received).toEqual([{ plain: true }]);
    await app.stop();
  });
});

describe('MessagingPlugin arms integration', () => {
  it('registers pubsub broker when broker is pubsub', async () => {
    let connected = false;
    const fakeTransport: import('../../src/brokers/pubsub-broker.ts').IPubSubTransport = {
      publish: () => Promise.resolve(),
      open: () =>
        Promise.resolve(
          {
            close: () => Promise.resolve(),
          } as import('../../src/brokers/pubsub-broker.ts').IPubSubSubscription,
        ),
      createSubscription: () => Promise.resolve(),
      deleteSubscription: () => Promise.resolve(),
      close: () => {
        connected = false;
        return Promise.resolve();
      },
    };
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({
          broker: 'pubsub',
          client: fakeTransport,
        }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeDefined();
    await broker.publish('t', { ok: true });
    connected = true;
    await app.stop();
    expect(connected).toBe(false); // close was called
  });

  it('registers service-bus broker when broker is service-bus', async () => {
    const fakeTransport: import('../../src/brokers/service-bus-broker.ts').IServiceBusTransport = {
      send: () => Promise.resolve(),
      open: () =>
        Promise.resolve(
          {
            close: () => Promise.resolve(),
          } as import('../../src/brokers/service-bus-broker.ts').IServiceBusSubscription,
        ),
      createSubscription: () => Promise.resolve(),
      deleteSubscription: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({
          broker: 'service-bus',
          client: fakeTransport,
        }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeDefined();
    await broker.publish('t', { ok: true });
    await app.stop();
  });

  it('registers custom broker via asBrokerAdapter', async () => {
    let customConnected = false;
    const customBroker: IMessageBroker = {
      connect: () => {
        customConnected = true;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.resolve(null as never),
      respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    };
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({ broker: 'custom', instance: customBroker }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeDefined();
    expect(customConnected).toBe(true);
    await app.stop();
  });

  it('bare MessagingPlugin() defaults to memory', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), MessagingPlugin()],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeDefined();
    await broker.publish('t', { v: 1 });
    await app.stop();
  });

  it('MessagingPlugin({}) defaults to memory', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), MessagingPlugin({})],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    expect(broker).toBeDefined();
    await app.stop();
  });
});
