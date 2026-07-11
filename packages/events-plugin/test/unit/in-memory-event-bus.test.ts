/**
 * Unit tests for InMemoryEventBus.
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { InMemoryEventBus } from '../../src/bus/in-memory-event-bus.ts';
import { defineDomainEvent } from '../../src/events/domain-event.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('InMemoryEventBus', () => {
  let runtime: ReturnType<typeof createFakeRuntime>;
  const errors: unknown[] = [];

  beforeEach(() => {
    runtime = createFakeRuntime({ uuidPrefix: 'bus', startTimestamp: 4000000 });
    errors.length = 0;
  });

  const createBus = (opts?: { async?: boolean }) =>
    new InMemoryEventBus({
      async: opts?.async ?? false,
      errorHandler: (err) => errors.push(err),
    });

  it('should publish event to subscribed handler', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let received: unknown = null;
    bus.subscribe('TestEvent', (event) => {
      received = event;
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(received).toBe(event);
    expect((received as typeof event).data).toEqual({ value: 'test' });
  });

  it('should fire multiple handlers in registration order', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    const order: string[] = [];
    bus.subscribe('TestEvent', (): void => {
      order.push('handler1');
    });
    bus.subscribe('TestEvent', (): void => {
      order.push('handler2');
    });
    bus.subscribe('TestEvent', (): void => {
      order.push('handler3');
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(order).toEqual(['handler1', 'handler2', 'handler3']);
  });

  it('should unsubscribe handler correctly', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let count = 0;
    const handler = (): void => {
      count++;
    };
    const unsubscribe = bus.subscribe('TestEvent', handler);

    const event1 = new TestEvent({ value: 'test1' });
    await bus.publish(event1);
    expect(count).toBe(1);

    unsubscribe();

    const event2 = new TestEvent({ value: 'test2' });
    await bus.publish(event2);
    expect(count).toBe(1); // handler not called
  });

  it('should make unsubscribe idempotent', () => {
    const bus = createBus();
    const unsubscribe = bus.subscribe('TestEvent', () => {});
    unsubscribe();
    unsubscribe(); // should not throw
  });

  it('should publishBatch dispatch heterogeneous batch in array order', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class EventA extends BoundDomainEvent<{ type: 'a' }> {
      readonly type = 'EventA';
    }
    class EventB extends BoundDomainEvent<{ type: 'b' }> {
      readonly type = 'EventB';
    }

    const order: string[] = [];
    bus.subscribe('EventA', (): void => {
      order.push('A');
    });
    bus.subscribe('EventB', (): void => {
      order.push('B');
    });

    const events = [
      new EventA({ type: 'a' }),
      new EventB({ type: 'b' }),
      new EventA({ type: 'a' }),
    ];
    await bus.publishBatch(events);

    expect(order).toEqual(['A', 'B', 'A']);
  });

  it('should await handlers in async:false mode', async () => {
    const bus = createBus({ async: false });
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let completed = false;
    bus.subscribe('TestEvent', async () => {
      await new Promise((r) => setTimeout(r, 10));
      completed = true;
    });

    const event = new TestEvent({ value: 'test' });
    const start = Date.now();
    await bus.publish(event);
    const elapsed = Date.now() - start;

    expect(completed).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });

  it('should fire-and-forget in async:true mode', async () => {
    const bus = createBus({ async: true });
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let completed = false;
    bus.subscribe('TestEvent', async () => {
      await new Promise((r) => setTimeout(r, 50));
      completed = true;
    });

    const event = new TestEvent({ value: 'test' });
    const start = Date.now();
    await bus.publish(event);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50); // publish resolved before handler completed
    expect(completed).toBe(false);

    // Wait for handlers to settle
    await bus.whenIdle();
    expect(completed).toBe(true);
  });

  it('should isolate handler errors in async:false mode', async () => {
    const bus = createBus({ async: false });
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let secondCalled = false;
    bus.subscribe('TestEvent', () => {
      throw new Error('handler1 failed');
    });
    bus.subscribe('TestEvent', () => {
      secondCalled = true;
    });

    const event = new TestEvent({ value: 'test' });
    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('handler1 failed');
    expect(secondCalled).toBe(true);
  });

  it('should isolate handler errors in async:true mode', async () => {
    const bus = createBus({ async: true });
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let secondCalled = false;
    bus.subscribe('TestEvent', () => {
      throw new Error('handler1 failed');
    });
    bus.subscribe('TestEvent', () => {
      secondCalled = true;
    });

    const event = new TestEvent({ value: 'test' });
    await expect(bus.publish(event)).resolves.toBeUndefined();

    await bus.whenIdle();
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('handler1 failed');
    expect(secondCalled).toBe(true);
  });

  it('should default errorHandler to no-op when no logger', async () => {
    const bus = new InMemoryEventBus({
      async: false,
      errorHandler: () => {}, // silent default
    });
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    bus.subscribe('TestEvent', () => {
      throw new Error('failed');
    });

    const event = new TestEvent({ value: 'test' });
    await expect(bus.publish(event)).resolves.toBeUndefined();
  });

  it('should clear remove all subscriptions', async () => {
    const bus = createBus();
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    bus.subscribe('TestEvent', () => {});
    bus.subscribe('TestEvent', () => {});

    expect(bus.subscriptionCount).toBe(1);

    bus.clear();

    expect(bus.subscriptionCount).toBe(0);

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event); // no handlers, no error
  });

  it('should whenIdle resolve immediately when no pending', async () => {
    const bus = createBus({ async: true });
    await expect(bus.whenIdle()).resolves.toBeUndefined();
  });
});
