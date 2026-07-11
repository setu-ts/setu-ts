/**
 * Unit tests for barrel exports.
 *
 * This test ensures that every exported value from the public package
 * specifier `@hono-enterprise/events-plugin` is reachable at runtime.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  defineDomainEvent,
  DomainEvent,
  EventsPlugin,
  InMemoryEventBus,
  IntegrationEvent,
  subscribeHandler,
} from '@hono-enterprise/events-plugin';
import type { IEventHandler } from '@hono-enterprise/events-plugin';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('events-plugin barrel exports', () => {
  it('exposes every documented value export at runtime', () => {
    expect(typeof EventsPlugin).toBe('function');
    expect(typeof InMemoryEventBus).toBe('function');
    expect(typeof DomainEvent).toBe('function');
    expect(typeof IntegrationEvent).toBe('function');
    expect(typeof defineDomainEvent).toBe('function');
    expect(typeof subscribeHandler).toBe('function'); // regression guard: was `undefined`
  });

  it('subscribeHandler reached via the barrel actually subscribes', async () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'barrel', startTimestamp: 1000 });
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const { DomainEvent: Bound } = defineDomainEvent(runtime);
    class TestEvent extends Bound<{ v: string }> {
      readonly type = 'TestEvent';
    }
    let seen: unknown = null;
    const handler: IEventHandler<{ v: string }> = {
      handle: (e) => {
        seen = e;
      },
    };
    const unsubscribe = subscribeHandler(bus, 'TestEvent', handler);
    const event = new TestEvent({ v: 'x' });
    await bus.publish(event);
    expect(seen).toBe(event);
    unsubscribe();
    seen = null;
    await bus.publish(new TestEvent({ v: 'y' }));
    expect(seen).toBeNull();
  });
});
