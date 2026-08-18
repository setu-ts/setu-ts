/**
 * The CQRS handler seam: the barrel writes no `new` and references each
 * artifact's factory by name, whichever schematic rendered it.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { COMMAND_HANDLER_SEAM, QUERY_HANDLER_SEAM } from '../../../src/seams/cqrs.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { GENERATED_LINE_WIDTH } from '../../../src/templates/root-settings.ts';

describe('cqrs seam', () => {
  it('entries are bare factory references, not constructions', () => {
    const barrel = COMMAND_HANDLER_SEAM.renderBarrel({
      'command-handler': ['order-item'],
      'query-handler': ['billing'],
    });
    expect(barrel).toContain(
      '{ type: ORDER_ITEM_COMMAND, handler: createOrderItemCommandHandler }',
    );
    expect(barrel).toContain('{ type: BILLING_QUERY, handler: createBillingQueryHandler }');
    expect(barrel).not.toContain('new ');
  });

  it('lists both kinds whichever schematic rendered the barrel', () => {
    // Both specs share one renderer, so a query-only generation still lists the
    // commands already present.
    const barrel = QUERY_HANDLER_SEAM.renderBarrel({
      'command-handler': ['billing'],
      'query-handler': ['order-item'],
    });
    expect(barrel).toContain('createBillingCommandHandler');
    expect(barrel).toContain('createOrderItemQueryHandler');
    expect(barrel).toContain('readonly CommandHandlerRegistration[]');
    expect(barrel).toContain('readonly QueryHandlerRegistration[]');
  });

  it('importSymbols swaps the class for the factory', () => {
    const names = deriveNames('order-item');
    expect(COMMAND_HANDLER_SEAM.importSymbols(names)).toEqual([
      'ORDER_ITEM_COMMAND',
      'createOrderItemCommandHandler',
    ]);
    expect(QUERY_HANDLER_SEAM.importSymbols(names)).toEqual([
      'ORDER_ITEM_QUERY',
      'createOrderItemQueryHandler',
    ]);
  });

  it('keeps the import line within the generated width with three artifacts per kind', () => {
    // The X2-4 class: an import the CLI wrote that the generated project's own
    // `deno fmt --check` rewraps. Three artifacts per kind is the realistic
    // maximum a single line carries before wrapping.
    const barrel = COMMAND_HANDLER_SEAM.renderBarrel({
      'command-handler': ['order-item', 'billing', 'refund-request'],
      'query-handler': ['list-orders', 'order-summary', 'billing-status'],
    });
    for (const line of barrel.split('\n')) {
      if (line.startsWith('import ')) {
        expect(line.length).toBeLessThanOrEqual(GENERATED_LINE_WIDTH);
      }
    }
  });

  it('renders an empty barrel that still declares both exports', () => {
    const empty = COMMAND_HANDLER_SEAM.renderBarrel({});
    expect(empty).toContain('export const COMMAND_HANDLERS');
    expect(empty).toContain('export const QUERY_HANDLERS');
    expect(empty).not.toContain('new ');
  });
});
