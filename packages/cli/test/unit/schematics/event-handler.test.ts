import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateEventHandler } from '../../../src/schematics/event-handler.ts';
import { gateOf, options } from './_shared.ts';

describe('event-handler schematic', () => {
  const files = generateEventHandler(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
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
      "import type { IEventHandler } from '@hono-enterprise/events-plugin';",
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
});
