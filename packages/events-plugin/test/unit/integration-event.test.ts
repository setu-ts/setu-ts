/**
 * Unit tests for IntegrationEvent.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { defineDomainEvent } from '../../src/events/domain-event.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('IntegrationEvent', () => {
  const runtime = createFakeRuntime({ uuidPrefix: 'int', startTimestamp: 3000000 });

  it('should be instanceof the bound IntegrationEvent class', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class UserCreatedIntegration extends BoundIntegrationEvent<{ userId: string }> {
      readonly type = 'UserCreated';
    }
    const event = new UserCreatedIntegration({ userId: '123' });
    expect(event).toBeInstanceOf(BoundIntegrationEvent);
  });

  it('should have DomainEvent properties', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class UserCreatedIntegration extends BoundIntegrationEvent<{ userId: string }> {
      readonly type = 'UserCreated';
    }
    const event = new UserCreatedIntegration({ userId: '123' });
    // Verify DomainEvent properties are present
    expect(event.id).toBeDefined();
    expect(event.occurredOn).toBeInstanceOf(Date);
    expect(event.data).toEqual({ userId: '123' });
    expect(event.type).toBe('UserCreated');
  });

  it('should generate id and occurredOn from runtime', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class UserCreatedIntegration extends BoundIntegrationEvent<{ userId: string }> {
      readonly type = 'UserCreated';
    }
    const event = new UserCreatedIntegration({ userId: '123' });
    expect(event.id).toBe('int-2');
    expect(event.occurredOn.getTime()).toBe(3000000);
  });

  it('should publish on the bus like any event', async () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class UserCreatedIntegration extends BoundIntegrationEvent<{ userId: string }> {
      readonly type = 'UserCreated';
    }

    const bus = new (await import('../../src/bus/in-memory-event-bus.ts')).InMemoryEventBus({
      async: false,
      errorHandler: () => {},
    });

    let received: unknown = null;
    bus.subscribe('UserCreated', (event) => {
      received = event;
    });

    const event = new UserCreatedIntegration({ userId: '123' });
    await bus.publish(event);

    expect(received).toBe(event);
    expect((received as typeof event).data).toEqual({ userId: '123' });
  });
});
