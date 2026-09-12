/**
 * Unit tests for aggregate-local domain event recording.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDomainEvent, IDomainEvents } from '@setu-ts/events-plugin';
import { createDomainEvents } from '@setu-ts/events-plugin';

function event(id: string): IDomainEvent<{ readonly id: string }> {
  return {
    type: 'order.placed',
    id,
    occurredOn: new Date(0),
    data: { id },
  };
}

describe('createDomainEvents', () => {
  it('records exact event references in insertion order', () => {
    const events: IDomainEvents = createDomainEvents();
    const first = event('first');
    const second = event('second');

    events.record(first);
    events.record(second);

    expect(events.pending()).toEqual([first, second]);
  });

  it('returns a snapshot that cannot mutate pending facts', () => {
    const events = createDomainEvents();
    const first = event('first');
    const second = event('second');
    events.record(first);
    events.record(second);

    const snapshot = events.pending() as IDomainEvent[];
    snapshot.pop();

    expect(events.pending()).toEqual([first, second]);
  });

  it('retains duplicate references and removes only the first one', () => {
    const events = createDomainEvents();
    const first = event('first');
    const middle = event('middle');

    events.record(first);
    events.record(middle);
    events.record(first);

    expect(events.remove(first)).toBe(true);
    expect(events.pending()).toEqual([middle, first]);
  });

  it('compares event references rather than IDs when removing', () => {
    const events = createDomainEvents();
    const recorded = event('same-id');
    const distinctReference = event('same-id');
    events.record(recorded);

    expect(events.remove(distinctReference)).toBe(false);
    expect(events.pending()).toEqual([recorded]);
  });

  it('leaves pending facts unchanged when removing an absent reference', () => {
    const events = createDomainEvents();
    const recorded = event('recorded');
    events.record(recorded);

    expect(events.remove(event('absent'))).toBe(false);
    expect(events.pending()).toEqual([recorded]);
  });

  it('clears every pending fact', () => {
    const events = createDomainEvents();
    events.record(event('first'));
    events.record(event('second'));

    events.clear();

    expect(events.pending()).toEqual([]);
  });

  it('starts a persistence-reconstructed aggregate with no pending facts', () => {
    class Order {
      readonly events = createDomainEvents();

      private constructor(readonly id: string) {}

      static fromPersistence(id: string): Order {
        return new Order(id);
      }

      place(): void {
        this.events.record(event(this.id));
      }
    }

    const order = Order.fromPersistence('persisted-order');
    expect(order.events.pending()).toEqual([]);

    order.place();
    expect(order.events.pending()).toEqual([event('persisted-order')]);
  });
});
