/**
 * Unit tests for DomainEvent and defineDomainEvent.
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { defineDomainEvent, DomainEvent } from '../../src/events/domain-event.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('DomainEvent', () => {
  let runtime: ReturnType<typeof createFakeRuntime>;

  beforeEach(() => {
    runtime = createFakeRuntime({ uuidPrefix: 'evt', startTimestamp: 1000000 });
  });

  it('should generate id from runtime.uuid()', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' });
    expect(event.id).toBe('evt-0');
  });

  it('should generate occurredOn from runtime.now()', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' });
    expect(event.occurredOn.getTime()).toBe(1000000);
  });

  it('should set data correctly', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' });
    expect(event.data).toEqual({ value: 'test' });
  });

  it('should omit aggregateId when not supplied', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' });
    expect('aggregateId' in event).toBe(false);
  });

  it('should set aggregateId when supplied', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' }, { aggregateId: 'agg-123' });
    expect((event as unknown as { aggregateId: string }).aggregateId).toBe('agg-123');
    expect('aggregateId' in event).toBe(true);
  });

  it('should omit version when not supplied', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' });
    expect('version' in event).toBe(false);
  });

  it('should set version when supplied', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent(runtime, { value: 'test' }, { version: 5 });
    expect((event as unknown as { version: number }).version).toBe(5);
    expect('version' in event).toBe(true);
  });

  it('should generate distinct ids across instances', () => {
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event1 = new TestEvent(runtime, { value: 'test1' });
    const event2 = new TestEvent(runtime, { value: 'test2' });
    expect(event1.id).not.toBe(event2.id);
  });
});

describe('defineDomainEvent', () => {
  let runtime: ReturnType<typeof createFakeRuntime>;

  beforeEach(() => {
    runtime = createFakeRuntime({ uuidPrefix: 'bound', startTimestamp: 2000000 });
  });

  it('should return runtime-bound DomainEvent base', () => {
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);
    class UserCreated extends BoundDomainEvent<{ userId: string }> {
      readonly type = 'UserCreated';
    }
    const event = new UserCreated({ userId: '123' });
    expect(event.id).toBe('bound-0');
    expect(event.occurredOn.getTime()).toBe(2000000);
    expect(event.data).toEqual({ userId: '123' });
  });

  it('should omit aggregateId when not supplied (bound)', () => {
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);
    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent({ value: 'test' });
    expect('aggregateId' in event).toBe(false);
  });

  it('should set aggregateId when supplied (bound)', () => {
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);
    class TestEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }
    const event = new TestEvent({ value: 'test' }, { aggregateId: 'agg-456' });
    expect((event as unknown as { aggregateId: string }).aggregateId).toBe('agg-456');
  });

  it('should return runtime-bound IntegrationEvent base', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class UserCreatedIntegration extends BoundIntegrationEvent<{ userId: string }> {
      readonly type = 'UserCreated';
    }
    const event = new UserCreatedIntegration({ userId: '123' });
    expect(event.id).toBe('bound-0');
    expect(event.occurredOn.getTime()).toBe(2000000);
    expect(event.data).toEqual({ userId: '123' });
    expect(event).toBeInstanceOf(BoundIntegrationEvent);
  });

  it('should omit aggregateId when not supplied (bound IntegrationEvent)', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class TestIntegrationEvent extends BoundIntegrationEvent<{ value: string }> {
      readonly type = 'TestIntegrationEvent';
    }
    const event = new TestIntegrationEvent({ value: 'test' });
    expect('aggregateId' in event).toBe(false);
  });

  it('should set aggregateId when supplied (bound IntegrationEvent)', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class TestIntegrationEvent extends BoundIntegrationEvent<{ value: string }> {
      readonly type = 'TestIntegrationEvent';
    }
    const event = new TestIntegrationEvent({ value: 'test' }, { aggregateId: 'agg-integration' });
    expect((event as unknown as { aggregateId: string }).aggregateId).toBe('agg-integration');
  });

  it('should omit version when not supplied (bound IntegrationEvent)', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class TestIntegrationEvent extends BoundIntegrationEvent<{ value: string }> {
      readonly type = 'TestIntegrationEvent';
    }
    const event = new TestIntegrationEvent({ value: 'test' });
    expect('version' in event).toBe(false);
  });

  it('should set version when supplied (bound IntegrationEvent)', () => {
    const { IntegrationEvent: BoundIntegrationEvent } = defineDomainEvent(runtime);
    class TestIntegrationEvent extends BoundIntegrationEvent<{ value: string }> {
      readonly type = 'TestIntegrationEvent';
    }
    const event = new TestIntegrationEvent({ value: 'test' }, { version: 7 });
    expect((event as unknown as { version: number }).version).toBe(7);
  });

  it('should produce identical field shapes for raw and bound construction', () => {
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);
    class RawEvent extends DomainEvent<{ value: string }> {
      readonly type = 'RawEvent';
    }
    class BoundEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'BoundEvent';
    }

    const raw = new RawEvent(runtime, { value: 'test' }, { aggregateId: 'agg', version: 3 });
    const bound = new BoundEvent({ value: 'test' }, { aggregateId: 'agg', version: 3 });

    expect(raw.id).not.toBe(bound.id); // different uuid
    expect(raw.occurredOn.getTime()).toBe(bound.occurredOn.getTime());
    expect(raw.data).toEqual(bound.data);
    expect((raw as unknown as { aggregateId: string }).aggregateId).toBe(
      (bound as unknown as { aggregateId: string }).aggregateId,
    );
    expect((raw as unknown as { version: number }).version).toBe(
      (bound as unknown as { version: number }).version,
    );
  });

  it('should produce identical field shapes when opts omitted', () => {
    const { DomainEvent: BoundDomainEvent } = defineDomainEvent(runtime);
    class RawEvent extends DomainEvent<{ value: string }> {
      readonly type = 'RawEvent';
    }
    class BoundEvent extends BoundDomainEvent<{ value: string }> {
      readonly type = 'BoundEvent';
    }

    const raw = new RawEvent(runtime, { value: 'test' });
    const bound = new BoundEvent({ value: 'test' });

    expect('aggregateId' in raw).toBe(false);
    expect('aggregateId' in bound).toBe(false);
    expect('version' in raw).toBe(false);
    expect('version' in bound).toBe(false);
  });
});
