import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateEventHandler } from '../../../src/schematics/event-handler.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('event-handler schematic', () => {
  const files = generateEventHandler(deriveNames('order-item'), options());
  const file = artifactOf(files, 'event-handler');

  it('emits the handler plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/events/order-item.event-handler.ts',
      'src/events/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('event-handler', 'order-item', ['gizmo', 'billing']);
  });

  it('references the factory by name, not a construction, as the barrel requires', () => {
    // The barrel writes no `new` anywhere: the handler is the artifact's factory
    // BY NAME, which is the single construction site.
    expect(barrelOf(files, 'event-handler').contents).toContain(
      '{ type: ORDER_ITEM_EVENT, handler: createOrderItemEventHandler }',
    );
    expect(barrelOf(files, 'event-handler').contents).toContain(
      'readonly EventHandlerRegistration[]',
    );
    expect(barrelOf(files, 'event-handler').contents).not.toContain('new ');
  });

  it('emits it at src/events/order-item.event-handler.ts', () => {
    expect(file.path).toBe('src/events/order-item.event-handler.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on events-plugin', () => {
    expect(gateOf('event-handler')).toBe('events-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateEventHandler(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('implements IEventHandler from the events plugin', () => {
    expect(file.contents).toContain(
      "import type { IEventHandler } from '@setu-ts/events-plugin';",
    );
    expect(file.contents).toContain('implements IEventHandler<OrderItemPayload>');
  });

  it('subscribes on the kebab event name', () => {
    expect(file.contents).toContain("export const ORDER_ITEM_EVENT = 'order-item';");
  });

  it('reads the committed IDomainEvent.data field', () => {
    expect(file.contents).toContain('event.data.id');
    expect(file.contents).not.toContain('event.payload');
  });

  it('emits a zero-parameter factory with a written-out return type', () => {
    // The factory is the single construction site; a written-out return type is
    // required because an inferred one is a JSR slow type.
    expect(file.contents).toContain(
      'export function createOrderItemEventHandler(): OrderItemEventHandler {',
    );
    expect(file.contents).toContain('return new OrderItemEventHandler();');
  });
});
