/**
 * The selection semantics are the ones `InMemoryBroker` documents — fan out to
 * every queue-less subscriber, one member per named group, round-robin — so
 * `SubscribeOptions.queue` means the same thing on every backend the framework
 * ships. Getting the group arm wrong would silently deliver one message to
 * every member of a consumer group.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { SubscriptionTable } from '../../../src/messaging/subscription-table.ts';

/** Builds a table whose handlers are their own names, so selection is readable. */
function tableWith(
  entries: readonly { readonly id: string; readonly topic: string; readonly queue?: string }[],
): SubscriptionTable<string> {
  const table = new SubscriptionTable<string>();
  for (const entry of entries) {
    table.add({
      id: entry.id,
      topic: entry.topic,
      handler: entry.id,
      ...(entry.queue === undefined ? {} : { queue: entry.queue }),
    });
  }
  return table;
}

/** The selected handlers, which are their ids. */
function selected(table: SubscriptionTable<string>, topic: string): readonly string[] {
  return table.select(topic).map((entry) => entry.handler);
}

describe('SubscriptionTable', () => {
  it('selects nothing for a topic nobody subscribed to', () => {
    const table = tableWith([{ id: 'a', topic: 'other' }]);
    expect(selected(table, 'orders')).toEqual([]);
    expect(table.has('orders')).toBe(false);
  });

  it('fans out to every subscriber that named no queue', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders' },
      { id: 'b', topic: 'orders' },
    ]);
    expect(selected(table, 'orders')).toEqual(['a', 'b']);
  });

  it('selects exactly one member of a named group', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders', queue: 'workers' },
      { id: 'b', topic: 'orders', queue: 'workers' },
    ]);
    expect(selected(table, 'orders')).toEqual(['a']);
  });

  it('rotates through a group across deliveries', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders', queue: 'workers' },
      { id: 'b', topic: 'orders', queue: 'workers' },
      { id: 'c', topic: 'orders', queue: 'workers' },
    ]);
    expect([
      selected(table, 'orders'),
      selected(table, 'orders'),
      selected(table, 'orders'),
      selected(table, 'orders'),
    ]).toEqual([['a'], ['b'], ['c'], ['a']]);
  });

  it('rotates each group independently', () => {
    const table = tableWith([
      { id: 'a1', topic: 'orders', queue: 'alpha' },
      { id: 'a2', topic: 'orders', queue: 'alpha' },
      { id: 'b1', topic: 'orders', queue: 'beta' },
      { id: 'b2', topic: 'orders', queue: 'beta' },
    ]);
    expect(selected(table, 'orders')).toEqual(['a1', 'b1']);
    expect(selected(table, 'orders')).toEqual(['a2', 'b2']);
  });

  it('combines fan-out and group selection in one delivery', () => {
    const table = tableWith([
      { id: 'broadcast', topic: 'orders' },
      { id: 'grouped-1', topic: 'orders', queue: 'workers' },
      { id: 'grouped-2', topic: 'orders', queue: 'workers' },
    ]);
    expect(selected(table, 'orders')).toEqual(['broadcast', 'grouped-1']);
    expect(selected(table, 'orders')).toEqual(['broadcast', 'grouped-2']);
  });

  it('keeps a cursor inside a group that shrank between deliveries', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders', queue: 'workers' },
      { id: 'b', topic: 'orders', queue: 'workers' },
      { id: 'c', topic: 'orders', queue: 'workers' },
    ]);
    expect(selected(table, 'orders')).toEqual(['a']);
    expect(selected(table, 'orders')).toEqual(['b']);
    table.remove('orders', 'c');
    // The cursor is past the shortened group's end here. Taken modulo on READ,
    // it wraps to a live member; taken on write it would index `undefined`.
    expect(selected(table, 'orders')).toEqual(['a']);
  });

  it('removes exactly one entry by id', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders' },
      { id: 'b', topic: 'orders' },
    ]);
    expect(table.remove('orders', 'a')).toBe(true);
    expect(selected(table, 'orders')).toEqual(['b']);
  });

  it('reports removal of an unknown id and an unknown topic as false', () => {
    const table = tableWith([{ id: 'a', topic: 'orders' }]);
    expect(table.remove('orders', 'missing')).toBe(false);
    expect(table.remove('nothing-here', 'a')).toBe(false);
  });

  it('drops a topic once its last subscriber leaves', () => {
    const table = tableWith([{ id: 'a', topic: 'orders' }]);
    expect(table.topics()).toEqual(['orders']);
    table.remove('orders', 'a');
    expect(table.topics()).toEqual([]);
    expect(table.has('orders')).toBe(false);
  });

  it('resets a group cursor with the topic, so a re-subscribe starts fresh', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders', queue: 'workers' },
      { id: 'b', topic: 'orders', queue: 'workers' },
    ]);
    expect(selected(table, 'orders')).toEqual(['a']);

    table.remove('orders', 'a');
    table.remove('orders', 'b');
    const rebuilt = tableWith([
      { id: 'a', topic: 'orders', queue: 'workers' },
      { id: 'b', topic: 'orders', queue: 'workers' },
    ]);
    expect(selected(rebuilt, 'orders')).toEqual(['a']);
  });

  it('clear() drops every topic', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders' },
      { id: 'b', topic: 'shipments' },
    ]);
    table.clear();
    expect(table.topics()).toEqual([]);
    expect(selected(table, 'orders')).toEqual([]);
  });

  it('reports the topics it carries, for the unroutable diagnostic', () => {
    const table = tableWith([
      { id: 'a', topic: 'orders' },
      { id: 'b', topic: 'shipments' },
    ]);
    expect([...table.topics()].sort()).toEqual(['orders', 'shipments']);
    expect(table.has('orders')).toBe(true);
  });
});
