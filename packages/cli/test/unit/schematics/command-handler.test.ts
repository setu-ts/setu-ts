import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateCommandHandler } from '../../../src/schematics/command-handler.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('command-handler schematic', () => {
  const files = generateCommandHandler(deriveNames('order-item'), options());
  const file = artifactOf(files, 'command-handler');

  it('emits the handler plus the shared cqrs seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/cqrs/order-item.command-handler.ts',
      'src/cqrs/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('command-handler', 'order-item', ['gizmo', 'billing']);
  });

  it('references the factory by name, not a construction, as the barrel requires', () => {
    // `ICommandBus.register(type, handler)` takes a pair, and the module already declares
    // the type constant — deriving it from the class name would be a second source of
    // truth for the same string. The handler is the artifact's factory BY NAME: the
    // barrel writes no `new` anywhere.
    expect(barrelOf(files, 'command-handler').contents).toContain(
      '{ type: ORDER_ITEM_COMMAND, handler: createOrderItemCommandHandler }',
    );
    expect(barrelOf(files, 'command-handler').contents).toContain(
      'readonly CommandHandlerRegistration[]',
    );
    expect(barrelOf(files, 'command-handler').contents).not.toContain('new ');
  });

  // Both schematics render the SAME barrel, so generating a command handler must not
  // drop a query handler already present.
  it('keeps existing query handlers in the shared barrel', () => {
    const withQueries = generateCommandHandler(
      deriveNames('order-item'),
      options([], [], { 'query-handler': ['billing'] }),
    );
    const barrel = barrelOf(withQueries, 'command-handler').contents;
    expect(barrel).toContain('createBillingQueryHandler');
    expect(barrel).toContain('createOrderItemCommandHandler');
  });

  it('emits it at src/cqrs/order-item.command-handler.ts', () => {
    expect(file.path).toBe('src/cqrs/order-item.command-handler.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on cqrs-plugin', () => {
    expect(gateOf('command-handler')).toBe('cqrs-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateCommandHandler(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the command and its handler', () => {
    expect(file.contents).toContain(
      'export interface OrderItemCommand extends CqrsCommand<OrderItemPayload>',
    );
    expect(file.contents).toContain(
      'implements ICommandHandler<OrderItemCommand, OrderItemResult>',
    );
  });

  it('defines every type it references', () => {
    for (const declared of ['OrderItemPayload', 'OrderItemResult']) {
      expect(file.contents).toContain(`export interface ${declared}`);
    }
  });

  it('emits a zero-parameter factory with a written-out return type', () => {
    // The factory is the single construction site; a written-out return type is
    // required because an inferred one is a JSR slow type.
    expect(file.contents).toContain(
      'export function createOrderItemCommandHandler(): OrderItemCommandHandler {',
    );
    expect(file.contents).toContain('return new OrderItemCommandHandler();');
  });
});
