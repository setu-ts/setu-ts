/**
 * Integration tests for EventsPlugin via kernel app.inject().
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { EventsPlugin } from '../../src/plugin/events-plugin.ts';
import { subscribeHandler } from '../../src/handlers/event-handler.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IEventBus, IPlugin } from '@setu-ts/common';
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

describe('EventsPlugin integration', () => {
  it('should publish event from route handler and fire subscriber', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), EventsPlugin()],
    });

    // Subscribe in a separate plugin
    let eventReceived: unknown = null;
    app.register({
      name: 'event-subscriber',
      version: '1.0.0',
      dependencies: ['events'],
      register(ctx) {
        const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
        bus.subscribe('UserCreated', (event) => {
          eventReceived = event;
        });
      },
    });

    // Route handler publishes event
    app.router.post('/users', async (ctx) => {
      const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publish({
        type: 'UserCreated',
        id: 'evt-123',
        occurredOn: new Date(),
        data: { userId: '123', email: 'john@example.com' },
      });
      return ctx.response.status(201).json({ userId: '123' });
    });

    await app.start();
    const response = await app.inject({
      method: 'POST',
      url: 'http://localhost/users',
      headers: new Headers(),
      body: { userId: '123' },
    });
    await app.stop();

    expect(response.statusCode).toBe(201);
    expect(eventReceived).toBeDefined();
    expect((eventReceived as { type: string }).type).toBe('UserCreated');
    expect((eventReceived as { data: { userId: string; email: string } }).data).toEqual({
      userId: '123',
      email: 'john@example.com',
    });
  });

  it('should publishBatch reach both subscribers in order', async () => {
    const app = createApplication({
      plugins: [fakeRuntimePlugin(), EventsPlugin()],
    });

    const order: string[] = [];

    app.register({
      name: 'batch-subscriber',
      version: '1.0.0',
      dependencies: ['events'],
      register(ctx) {
        const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
        bus.subscribe('EventA', () => {
          order.push('A');
        });
        bus.subscribe('EventB', () => {
          order.push('B');
        });
      },
    });

    app.router.post('/batch', async (ctx) => {
      const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publishBatch([
        {
          type: 'EventA',
          id: 'a1',
          occurredOn: new Date(),
          data: { type: 'a' },
        },
        {
          type: 'EventB',
          id: 'b1',
          occurredOn: new Date(),
          data: { type: 'b' },
        },
      ]);
      return ctx.response.status(200).json({ ok: true });
    });

    await app.start();
    const response = await app.inject({
      method: 'POST',
      url: 'http://localhost/batch',
      headers: new Headers(),
      body: {},
    });
    await app.stop();

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['A', 'B']);
  });

  it('should not break request when handler fails', async () => {
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        EventsPlugin({
          errorHandler: () => {}, // silent
        }),
      ],
    });

    app.register({
      name: 'failing-subscriber',
      version: '1.0.0',
      dependencies: ['events'],
      register(ctx) {
        const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
        bus.subscribe('TestEvent', () => {
          throw new Error('handler failed');
        });
      },
    });

    app.router.post('/test', async (ctx) => {
      const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publish({
        type: 'TestEvent',
        id: 'evt-1',
        occurredOn: new Date(),
        data: {},
      });
      return ctx.response.status(200).json({ ok: true });
    });

    await app.start();
    const response = await app.inject({
      method: 'POST',
      url: 'http://localhost/test',
      headers: new Headers(),
      body: {},
    });
    await app.stop();

    expect(response.statusCode).toBe(200);
  });

  // The declarative subscription option, driven through a real application rather than a
  // hand-rolled plugin context: the option exists precisely because application code has
  // no phase in which to reach the bus, and a mock context would hide that.
  describe('declarative handler subscription', () => {
    it('delivers a published event to a handler supplied through options', async () => {
      const seen: string[] = [];
      const app = createApplication({
        plugins: [
          fakeRuntimePlugin(),
          EventsPlugin({
            handlers: [
              {
                type: 'TestEvent',
                handler: { handle: (event) => void seen.push(String(event.id)) },
              },
            ],
          }),
        ],
      });
      await app.start();

      await app.services
        .get<IEventBus>(CAPABILITIES.EVENTS)
        .publish({ type: 'TestEvent', id: 'evt-1', occurredOn: new Date(), data: {} });
      await app.stop();

      expect(seen).toEqual(['evt-1']);
    });

    // One implementation behind two entry points: the option routes through the same
    // exported `subscribeHandler` a caller would use, so the two cannot diverge.
    it('delivers identically through the option and a manual subscribeHandler', async () => {
      const viaOption: string[] = [];
      const viaCode: string[] = [];
      const app = createApplication({
        plugins: [
          fakeRuntimePlugin(),
          EventsPlugin({
            handlers: [
              {
                type: 'TestEvent',
                handler: { handle: (event) => void viaOption.push(String(event.id)) },
              },
            ],
          }),
        ],
      });
      app.register({
        name: 'manual',
        version: '1.0.0',
        dependencies: ['events'],
        register(ctx) {
          subscribeHandler(ctx.services.get<IEventBus>(CAPABILITIES.EVENTS), 'TestEvent', {
            handle: (event) => void viaCode.push(String(event.id)),
          });
        },
      });
      await app.start();

      await app.services
        .get<IEventBus>(CAPABILITIES.EVENTS)
        .publish({ type: 'TestEvent', id: 'evt-2', occurredOn: new Date(), data: {} });
      await app.stop();

      expect(viaOption).toEqual(viaCode);
      expect(viaOption).toEqual(['evt-2']);
    });

    it('subscribes nothing when the option is omitted', async () => {
      // Pins that the addition is inert by default, so an upgrade changes no behaviour.
      const app = createApplication({ plugins: [fakeRuntimePlugin(), EventsPlugin()] });
      await app.start();
      const bus = app.services.get<IEventBus>(CAPABILITIES.EVENTS);
      // A publish with no subscriber resolves rather than throwing, so the observable
      // difference is the plugin's own subscription count.
      await bus.publish({ type: 'TestEvent', id: 'evt-3', occurredOn: new Date(), data: {} });
      await app.stop();

      expect((bus as unknown as { subscriptionCount: number }).subscriptionCount).toBe(0);
    });
  });
});
