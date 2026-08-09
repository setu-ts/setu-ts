import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateQueryHandler } from '../../../src/schematics/query-handler.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('query-handler schematic', () => {
  const files = generateQueryHandler(deriveNames('order-item'), options());
  const file = artifactOf(files, 'query-handler');

  it('emits the handler plus the shared cqrs seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/cqrs/order-item.query-handler.ts',
      'src/cqrs/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('query-handler', 'order-item', ['gizmo', 'billing']);
  });

  it('carries the query type alongside the handler, as the bus requires', () => {
    expect(barrelOf(files, 'query-handler').contents).toContain(
      '{ type: ORDER_ITEM_QUERY, handler: new OrderItemQueryHandler() }',
    );
    expect(barrelOf(files, 'query-handler').contents).toContain(
      'readonly QueryHandlerRegistration[]',
    );
  });

  it('keeps existing command handlers in the shared barrel', () => {
    const withCommands = generateQueryHandler(
      deriveNames('order-item'),
      options([], [], { 'command-handler': ['billing'] }),
    );
    const barrel = barrelOf(withCommands, 'query-handler').contents;
    expect(barrel).toContain('BillingCommandHandler');
    expect(barrel).toContain('OrderItemQueryHandler');
  });

  it('emits it at src/cqrs/order-item.query-handler.ts', () => {
    expect(file.path).toBe('src/cqrs/order-item.query-handler.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on cqrs-plugin', () => {
    expect(gateOf('query-handler')).toBe('cqrs-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateQueryHandler(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the query and its handler', () => {
    expect(file.contents).toContain(
      'export interface OrderItemQuery extends CqrsQuery<OrderItemCriteria>',
    );
    expect(file.contents).toContain('implements IQueryHandler<OrderItemQuery, OrderItemView>');
  });

  it('defines every type it references', () => {
    for (const declared of ['OrderItemCriteria', 'OrderItemView']) {
      expect(file.contents).toContain(`export interface ${declared}`);
    }
  });
});
