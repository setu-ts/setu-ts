import { describe, expect, it } from 'vitest';

import { moduleActive, moduleSymbol, withoutImports } from '../../src/diagnostics/modules.ts';

describe('module activation', () => {
  it('names the registrar or the module class by mode', () => {
    expect(moduleSymbol('order-book', 'functional')).toBe('registerOrderBookModule');
    expect(moduleSymbol('order-book', 'class-based')).toBe('OrderBookModule');
  });

  it('counts a functional registrar only when it is called', () => {
    const imported = "import { registerOrdersModule } from './orders/index.ts';\n";
    expect(
      moduleActive(
        `${imported}registerOrdersModule(router, services);\n`,
        'registerOrdersModule',
        'functional',
      ),
    ).toBe(true);
    expect(moduleActive(imported, 'registerOrdersModule', 'functional')).toBe(false);
    expect(
      moduleActive(
        `${imported}export { registerOrdersModule };\n`,
        'registerOrdersModule',
        'functional',
      ),
    ).toBe(false);
  });

  it('counts a class only as an element of MODULES', () => {
    const imported = "import { OrdersModule } from './orders/orders.module.ts';\n";
    expect(
      moduleActive(
        `${imported}export const MODULES = [OrdersModule];\n`,
        'OrdersModule',
        'class-based',
      ),
    ).toBe(true);
    expect(
      moduleActive(
        `${imported}export const MODULES = [];\nconst other = [OrdersModule];\n`,
        'OrdersModule',
        'class-based',
      ),
    ).toBe(false);
    expect(
      moduleActive(`${imported}const other = [OrdersModule];\n`, 'OrdersModule', 'class-based'),
    ).toBe(false);
  });

  it('treats a mention inside a string or comment as inactive', () => {
    expect(
      moduleActive('// registerOrdersModule(router)\n', 'registerOrdersModule', 'functional'),
    ).toBe(false);
    expect(
      moduleActive(
        "const s = 'registerOrdersModule(router)';\n",
        'registerOrdersModule',
        'functional',
      ),
    ).toBe(false);
  });

  it('treats source it cannot classify as inactive', () => {
    expect(
      moduleActive(
        'const s = `registerOrdersModule(router)`;\nregisterOrdersModule(router);\n',
        'registerOrdersModule',
        'functional',
      ),
    ).toBe(false);
    expect(withoutImports(undefined)).toBeUndefined();
  });
});
