/**
 * Unit tests for IEventHandler and subscribeHandler.
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { InMemoryEventBus } from '../../src/bus/in-memory-event-bus.ts';
import { defineDomainEvent } from '../../src/events/domain-event.ts';
import type { IEventHandler } from '../../src/handlers/event-handler.ts';
import { subscribeHandler } from '../../src/handlers/event-handler.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('IEventHandler / subscribeHandler', () => {
  let runtime: ReturnType<typeof createFakeRuntime>;
  const errors: unknown[] = [];

  beforeEach(() => {
    runtime = createFakeRuntime({ uuidPrefix: 'hnd', startTimestamp: 5000000 });
    errors.length = 0;
  });

  const createBus = () =>
    new InMemoryEventBus({
      async: false,
      errorHandler: (err) => errors.push(err),
    });

  it('should invoke IEventHandler.handle on publish', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    class TestHandler implements IEventHandler<{ value: string }> {
      called = false;
      receivedEvent: unknown = null;
      handle(event: unknown) {
        this.called = true;
        this.receivedEvent = event;
      }
    }

    const handler = new TestHandler();
    subscribeHandler(bus, 'TestEvent', handler);

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(handler.called).toBe(true);
    expect(handler.receivedEvent).toBe(event);
    expect((handler.receivedEvent as typeof event).data).toEqual({ value: 'test' });
  });

  it('should unsubscribe via returned function', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    class TestHandler implements IEventHandler<{ value: string }> {
      called = false;
      handle() {
        this.called = true;
      }
    }

    const handler = new TestHandler();
    const unsubscribe = subscribeHandler(bus, 'TestEvent', handler);

    const event1 = new TestEvent({ value: 'test1' });
    await bus.publish(event1);
    expect(handler.called).toBe(true);

    unsubscribe();

    handler.called = false;
    const event2 = new TestEvent({ value: 'test2' });
    await bus.publish(event2);
    expect(handler.called).toBe(false);
  });
});
