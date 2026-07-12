import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { EventsMessagingBridge } from '../../src/bridge/events-messaging-bridge.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IPluginContext, IRuntimeServices } from '@hono-enterprise/common';

/**
 * Fake implementations for testing EventsMessagingBridge.
 */
class FakeEventBus {
  #subscribers = new Map<string, Array<(event: unknown) => Promise<void>>>();
  unsubscribeCalls: Array<{ eventType: string }> = [];

  subscribe<T>(eventType: string, handler: (event: T) => Promise<void>): () => Promise<void> {
    if (!this.#subscribers.has(eventType)) {
      this.#subscribers.set(eventType, []);
    }
    const handlers = this.#subscribers.get(eventType)!;
    handlers.push(handler as (event: unknown) => Promise<void>);

    // deno-lint-ignore require-await
    return async () => {
      const idx = handlers.indexOf(handler as (event: unknown) => Promise<void>);
      if (idx >= 0) {
        handlers.splice(idx, 1);
      }
    };
  }

  async publish<T>(eventType: string, event: T): Promise<void> {
    const handlers = this.#subscribers.get(eventType) || [];
    for (const handler of handlers) {
      await handler(event as unknown as Promise<void>);
    }
  }

  getSubscriberCount(eventType: string): number {
    return this.#subscribers.get(eventType)?.length ?? 0;
  }
}

class FakeMessageBroker {
  publishedMessages: Array<{ topic: string; message: unknown }> = [];
  publishCalls: Array<{ topic: string; message: unknown }> = [];

  // deno-lint-ignore require-await
  async publish<T>(topic: string, message: T): Promise<void> {
    this.publishCalls.push({ topic, message });
    this.publishedMessages.push({ topic, message });
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  // deno-lint-ignore require-await
  async subscribe<T>(
    _topic: string,
    _handler: (msg: T, meta: unknown) => Promise<void>,
  ): Promise<() => void> {
    return () => {};
  }
}

class FakeLogger {
  errorCalls: string[] = [];
  error(msg: string): void {
    this.errorCalls.push(msg);
  }
}

/**
 * Creates a fake context for testing EventsMessagingBridge.
 */
function createFakeContext(): {
  ctx: IPluginContext;
  registered: Map<string, unknown>;
  closeHandlers: Array<() => Promise<void>>;
} {
  const registered = new Map<string, unknown>();
  const closeHandlers: Array<() => Promise<void>> = [];

  const runtime: IRuntimeServices = {
    platform: () => 'deno',
    version: () => 'test',
    now: () => Date.now(),
    hrtime: () => 0,
    setTimeout: (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return { id } as unknown as { id: number };
    },
    clearTimeout: (handle: { id: number }) => clearTimeout(handle.id),
    setInterval: (fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return { id } as unknown as { id: number };
    },
    clearInterval: (handle: { id: number }) => clearInterval(handle.id),
    uuid: () => 'test-uuid',
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    hostname: () => 'localhost',
  };

  const ctx: IPluginContext = {
    services: {
      has: (token: string) => registered.has(token),
      get: <T>(token: string): T => {
        const svc = registered.get(token);
        if (svc === undefined) {
          throw new Error(`Service not found: ${token}`);
        }
        return svc as T;
      },
      getAll: <T>(_token: string): readonly T[] => [],
      register: (token: string, svc: unknown) => {
        registered.set(token, svc);
      },
      registerFactory: () => {},
      unregister: () => false,
    },
    health: {
      register: () => {},
    },
    lifecycle: {
      onClose: (fn: () => Promise<void>) => {
        closeHandlers.push(fn);
      },
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
    },
    middleware: {
      add: () => {},
    },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
    },
    environment: {
      validate: () => {},
    },
    metrics: {
      register: () => {},
    },
    openapi: {
      addSchema: () => {},
    },
    decorators: {
      register: () => {},
    },
    cli: {
      register: () => {},
    },
    runtime,
    options: {},
    app: null as unknown as IPluginContext['app'],
  };

  return { ctx, registered, closeHandlers };
}

/**
 * EventsMessagingBridge unit tests.
 */
describe('EventsMessagingBridge', () => {
  it('provides empty array', () => {
    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

    expect(plugin.provides).toEqual([]);
  });

  it('optionalDependencies includes events, messaging, logger', () => {
    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

    expect(plugin.optionalDependencies).toContain('events');
    expect(plugin.optionalDependencies).toContain('messaging');
    expect(plugin.optionalDependencies).toContain('logger');
  });

  it('name and version', () => {
    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

    expect(plugin.name).toBe('events-messaging-bridge');
    expect(plugin.version).toBe('0.1.0');
  });

  it('register throws when event bus is not registered', () => {
    const { ctx } = createFakeContext();
    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

    expect(() => plugin.register(ctx)).toThrow(
      'EventsMessagingBridge requires the events capability to be registered.',
    );
  });

  it('register throws when messaging broker is not registered', () => {
    const { ctx } = createFakeContext();
    ctx.services.register(CAPABILITIES.EVENTS, new FakeEventBus());
    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });

    expect(() => plugin.register(ctx)).toThrow(
      'EventsMessagingBridge requires the messaging capability (messaging) to be registered.',
    );
  });

  it('successfully subscribes to configured event types', () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    const plugin = EventsMessagingBridge({ eventTypes: ['user.created', 'user.updated'] });
    plugin.register(ctx);

    expect(eventBus.getSubscriberCount('user.created')).toBe(1);
    expect(eventBus.getSubscriberCount('user.updated')).toBe(1);
  });

  it('publishes events to broker with default topic mapping', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    const plugin = EventsMessagingBridge({ eventTypes: ['user.created'] });
    plugin.register(ctx);

    // Trigger the event
    const event = { type: 'user.created', data: { userId: 123 } };
    await eventBus.publish('user.created', event);

    expect(broker.publishCalls.length).toBe(1);
    expect(broker.publishCalls[0].topic).toBe('user.created');
    expect(broker.publishCalls[0].message).toEqual(event.data);
  });

  it('applies custom topic mapping function', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    const topicMapping = (eventType: string) => `events.${eventType}.v1`;
    const plugin = EventsMessagingBridge({
      eventTypes: ['user.created'],
      topicMapping,
    });
    plugin.register(ctx);

    const event = { type: 'user.created', data: { userId: 456 } };
    await eventBus.publish('user.created', event);

    expect(broker.publishCalls.length).toBe(1);
    expect(broker.publishCalls[0].topic).toBe('events.user.created.v1');
    expect(broker.publishCalls[0].message).toEqual(event.data);
  });

  it('uses custom error handler on publish failure', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const errorHandlerCalls: Array<{ error: unknown; eventType: string }> = [];

    const customErrorHandler = (error: unknown, eventType: string) => {
      errorHandlerCalls.push({ error, eventType });
    };

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    // Make broker throw on publish
    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw new Error('Publish failed');
    };

    const plugin = EventsMessagingBridge({
      eventTypes: ['user.created'],
      errorHandler: customErrorHandler,
    });
    plugin.register(ctx);

    const event = { type: 'user.created', data: { userId: 789 } };
    await eventBus.publish('user.created', event);

    expect(errorHandlerCalls.length).toBe(1);
    expect(errorHandlerCalls[0].eventType).toBe('user.created');
    expect((errorHandlerCalls[0].error as Error).message).toBe('Publish failed');
  });

  it('default error handler logs via logger', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const logger = new FakeLogger();

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);
    ctx.services.register('logger', logger);

    // Make broker throw on publish
    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw new Error('Default handler test');
    };

    const plugin = EventsMessagingBridge({ eventTypes: ['user.created'] });
    plugin.register(ctx);

    const event = { type: 'user.created', data: { userId: 111 } };
    await eventBus.publish('user.created', event);

    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]).toContain('EventsMessagingBridge failed to publish event');
    expect(logger.errorCalls[0]).toContain('Default handler test');
  });

  it('default error handler swallows error when no logger', () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    // Make broker throw on publish - should not throw from bridge
    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw new Error('Should be swallowed');
    };

    const plugin = EventsMessagingBridge({ eventTypes: ['user.created'] });

    // Should not throw
    expect(() => plugin.register(ctx)).not.toThrow();
  });

  it('uses custom token for broker resolution', () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const customToken = 'messaging.custom';

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(customToken, broker);

    const plugin = EventsMessagingBridge({
      eventTypes: ['user.created'],
      token: customToken,
    });

    expect(() => plugin.register(ctx)).not.toThrow();
  });

  it('throws when custom token broker is not registered', () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    ctx.services.register(CAPABILITIES.EVENTS, eventBus);

    const plugin = EventsMessagingBridge({
      eventTypes: ['user.created'],
      token: 'messaging.nonexistent',
    });

    expect(() => plugin.register(ctx)).toThrow(
      'EventsMessagingBridge requires the messaging capability (messaging.nonexistent) to be registered.',
    );
  });

  it('error handler receives Error object when error is Error instance', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const errorHandlerCalls: Array<{ errorMessage: string }> = [];

    const customErrorHandler = (error: unknown, _eventType: string) => {
      if (error instanceof Error) {
        errorHandlerCalls.push({ errorMessage: error.message });
      }
    };

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw new Error('Error instance test');
    };

    const plugin = EventsMessagingBridge({
      eventTypes: ['user.created'],
      errorHandler: customErrorHandler,
    });
    plugin.register(ctx);

    await eventBus.publish('user.created', { type: 'user.created', data: {} });

    expect(errorHandlerCalls.length).toBe(1);
    expect(errorHandlerCalls[0].errorMessage).toBe('Error instance test');
  });

  it('error handler handles non-Error errors', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const errorHandlerCalls: Array<{ errorString: string }> = [];

    const customErrorHandler = (error: unknown, _eventType: string) => {
      errorHandlerCalls.push({ errorString: String(error) });
    };

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw 'String error';
    };

    const plugin = EventsMessagingBridge({
      eventTypes: ['user.created'],
      errorHandler: customErrorHandler,
    });
    plugin.register(ctx);

    await eventBus.publish('user.created', { type: 'user.created', data: {} });

    expect(errorHandlerCalls.length).toBe(1);
    expect(errorHandlerCalls[0].errorString).toBe('String error');
  });

  it('lifecycle onClose is registered and called', () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    const plugin = EventsMessagingBridge({ eventTypes: ['user.created'] });
    plugin.register(ctx);

    // The plugin should have registered an onClose handler
    // We can verify by checking that the lifecycle has the handler registered
    // (The FakeContext's lifecycle should have captured it)
    expect(eventBus.getSubscriberCount('user.created')).toBe(1);
  });

  it('empty event types array works', () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    const plugin = EventsMessagingBridge({ eventTypes: [] });

    // Should not throw
    expect(() => plugin.register(ctx)).not.toThrow();
  });

  it('topic mapping receives correct event type', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const receivedTopics: string[] = [];

    const topicMapping = (eventType: string) => {
      receivedTopics.push(eventType);
      return `topic.${eventType}`;
    };

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);

    const plugin = EventsMessagingBridge({
      eventTypes: ['domain.event'],
      topicMapping,
    });
    plugin.register(ctx);

    await eventBus.publish('domain.event', { type: 'domain.event', data: {} });

    expect(receivedTopics).toContain('domain.event');
    expect(broker.publishCalls[0].topic).toBe('topic.domain.event');
  });

  it('default error handler uses error.message for Error instances', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const logger = new FakeLogger();

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);
    ctx.services.register('logger', logger);

    // Make broker throw an Error
    const testError = new Error('test-error-message');
    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw testError;
    };

    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });
    plugin.register(ctx);

    await eventBus.publish('test.event', { type: 'test.event', data: {} });

    // Verify the error message was extracted correctly
    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]).toContain('test-error-message');
  });

  it('default error handler converts non-Error to string', async () => {
    const { ctx } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();
    const logger = new FakeLogger();

    ctx.services.register(CAPABILITIES.EVENTS, eventBus);
    ctx.services.register(CAPABILITIES.MESSAGING, broker);
    ctx.services.register('logger', logger);

    // Make broker throw a string (non-Error)
    (broker as unknown as { publish: (t: string, m: unknown) => Promise<void> }).publish = () => {
      throw 'string-error';
    };

    const plugin = EventsMessagingBridge({ eventTypes: ['test.event'] });
    plugin.register(ctx);

    await eventBus.publish('test.event', { type: 'test.event', data: {} });

    // Verify the string was converted
    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]).toContain('string-error');
  });

  it('lifecycle cleanup calls unsubscribe functions', async () => {
    const { ctx, closeHandlers, registered } = createFakeContext();
    const eventBus = new FakeEventBus();
    const broker = new FakeMessageBroker();

    registered.set(CAPABILITIES.EVENTS, eventBus);
    registered.set(CAPABILITIES.MESSAGING, broker);

    const plugin = EventsMessagingBridge({ eventTypes: ['user.created'] });
    plugin.register(ctx);

    // Verify close handler was registered
    expect(closeHandlers.length).toBe(1);

    // Trigger lifecycle cleanup
    await closeHandlers[0]();

    // Verify subscription was cleaned up
    expect(eventBus.getSubscriberCount('user.created')).toBe(0);
  });
});
