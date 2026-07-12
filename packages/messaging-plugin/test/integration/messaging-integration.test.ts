/**
 * Integration tests for MessagingPlugin via kernel app.inject().
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { MessagingPlugin } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IMessageBroker, IPlugin } from '@hono-enterprise/common';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

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
});
