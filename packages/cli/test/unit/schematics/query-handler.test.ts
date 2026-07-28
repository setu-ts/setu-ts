import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateQueryHandler } from '../../../src/schematics/query-handler.ts';
import { gateOf, options } from './_shared.ts';

describe('query-handler schematic', () => {
  const files = generateQueryHandler(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
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
