import { describe, expect, it } from 'vitest';
import {
  renderFunctionalModuleIndex,
  renderFunctionalModuleBarrel,
  registerModuleSymbol,
  REGISTER_MODULES_EXPORT,
} from '../../../src/seams/modules.ts';
import { deriveNames } from '../../../src/utils/names.ts';

describe('functional module registration', () => {
  it('uses the shared names and calls every sibling in sorted filename order', () => {
    expect(registerModuleSymbol(deriveNames('invoices'))).toBe('registerInvoicesModule');
    expect(REGISTER_MODULES_EXPORT).toBe('registerModules');
    const source = renderFunctionalModuleIndex(deriveNames('invoices'), {
      controller: ['billing', 'summary', 'invoices'],
    });
    const calls = [...source.matchAll(/ {2}(register\w+)\(router, services\);/g)].map((m) => m[1]);
    expect(calls).toEqual([
      'registerBillingRoutes',
      'registerInvoicesRoutes',
      'registerSummaryRoutes',
    ]);
    expect(source).not.toContain('export *');
  });
  it('uses both parameters even for empty modules and activation barrels', () => {
    for (const source of [
      renderFunctionalModuleIndex(deriveNames('empty'), {}),
      renderFunctionalModuleBarrel([]),
    ]) {
      expect(source).toContain('void router;');
      expect(source).toContain('void services;');
    }
  });
  it('deduplicates and sorts the activation barrel regardless of input order', () => {
    const source = renderFunctionalModuleBarrel(['zebra', 'billing', 'orders', 'billing']);
    expect(source).toBe(renderFunctionalModuleBarrel(['orders', 'billing', 'zebra']));
    expect(source.indexOf('registerBillingModule(router')).toBeLessThan(
      source.indexOf('registerOrdersModule(router'),
    );
    expect(source.indexOf('registerOrdersModule(router')).toBeLessThan(
      source.indexOf('registerZebraModule(router'),
    );
  });
});
