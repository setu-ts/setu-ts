/**
 * The domain-event-handler seam: the barrel writes no `new` and references
 * each artifact's factory by name.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { EVENTS_SEAM } from '../../../src/seams/events.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { GENERATED_LINE_WIDTH } from '../../../src/templates/root-settings.ts';

describe('events seam', () => {
  it('entries are bare factory references, not constructions', () => {
    const barrel = EVENTS_SEAM.renderBarrel({
      'event-handler': ['order-item'],
    });
    expect(barrel).toContain('{ type: ORDER_ITEM_EVENT, handler: createOrderItemEventHandler }');
    expect(barrel).not.toContain('new ');
    expect(barrel).toContain('readonly EventHandlerRegistration[]');
  });

  it('importSymbols swaps the class for the factory', () => {
    const names = deriveNames('order-item');
    expect(EVENTS_SEAM.importSymbols(names)).toEqual([
      'ORDER_ITEM_EVENT',
      'createOrderItemEventHandler',
    ]);
  });

  it('keeps the import line within the generated width with three artifacts', () => {
    // The X2-4 class: an import the CLI wrote that the generated project's own
    // `deno fmt --check` rewraps. The factory symbol is longer than the class
    // symbol it replaces, so the per-artifact import line must still fit.
    const barrel = EVENTS_SEAM.renderBarrel({
      'event-handler': ['order-item', 'billing', 'refund-request'],
    });
    for (const line of barrel.split('\n')) {
      if (line.startsWith('import ')) {
        expect(line.length).toBeLessThanOrEqual(GENERATED_LINE_WIDTH);
      }
    }
  });

  it('keeps names sorted regardless of input order', () => {
    const barrel = EVENTS_SEAM.renderBarrel({
      'event-handler': ['zeta', 'alpha'],
    });
    const alpha = barrel.indexOf('createAlphaEventHandler');
    const zeta = barrel.indexOf('createZetaEventHandler');
    expect(alpha).toBeGreaterThan(-1);
    expect(zeta).toBeGreaterThan(-1);
    expect(alpha).toBeLessThan(zeta);
  });

  it('renders an empty barrel that still declares the export', () => {
    const empty = EVENTS_SEAM.renderBarrel({});
    expect(empty).toContain('export const EVENT_HANDLERS');
    expect(empty).not.toContain('new ');
  });
});
