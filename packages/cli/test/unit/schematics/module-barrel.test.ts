/**
 * Unit tests for the aggregate module barrel renderer.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  LEGACY_CONTROLLERS_EXPORT,
  LEGACY_SERVICES_EXPORT,
  MODULES_EXPORT,
  renderModuleBarrel,
} from '../../../src/schematics/module-barrel.ts';

describe('renderModuleBarrel', () => {
  it('emits an empty activation list for a project with no modules', () => {
    const source = renderModuleBarrel([]);

    expect(source).toContain(`export const ${MODULES_EXPORT}: readonly Constructor[] = [];`);
    // No module imports at all — only the type import.
    expect(source).not.toContain('.controller.ts');
  });

  it('imports and lists a module class per module', () => {
    const source = renderModuleBarrel(['user']);

    expect(source).toContain(
      "import { UserModule } from './user/user.module.ts';",
    );
    expect(source).toContain(`export const ${MODULES_EXPORT}: readonly Constructor[] = [`);
    expect(source).toContain('UserModule');
  });

  it('derives PascalCase class names from a multi-word kebab directory', () => {
    const source = renderModuleBarrel(['order-item']);

    expect(source).toContain(
      "import { OrderItemModule } from './order-item/order-item.module.ts';",
    );
    expect(source).toContain('OrderItemModule');
  });

  it('sorts modules so enumeration order cannot change the output', () => {
    // `readdir` order is filesystem-defined. Without the sort, two machines
    // holding identical modules would render byte-different barrels and a
    // no-op regeneration would show up as a diff.
    const forward = renderModuleBarrel(['user', 'order', 'billing']);
    const reversed = renderModuleBarrel(['billing', 'user', 'order']);

    expect(forward).toBe(reversed);
    expect(forward.indexOf('BillingModule')).toBeLessThan(
      forward.indexOf('OrderModule'),
    );
    expect(forward.indexOf('OrderModule')).toBeLessThan(forward.indexOf('UserModule'));
  });

  it('lists a duplicated module name exactly once', () => {
    // The schematic unions the existing set with the new name, so a regeneration
    // over an existing module passes that name twice.
    const source = renderModuleBarrel(['user', 'user']);

    expect(source.match(/UserModule/g)?.length).toBe(2); // one import, one array entry
    expect(source.match(/from '\.\/user\/user\.module\.ts'/g)?.length).toBe(1);
  });

  it('breaks a long array onto indented lines', () => {
    const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

    const source = renderModuleBarrel(many);

    expect(source).toContain(`export const ${MODULES_EXPORT}: readonly Constructor[] = [\n`);
    expect(source).toContain('  AlphaModule,\n');
  });

  it('tells the reader the CLI owns the file', () => {
    const source = renderModuleBarrel([]);

    expect(source).toContain('setu generate module');
    expect(source).toContain('edits here are lost');
  });

  it('imports the Constructor type it annotates with', () => {
    // Without this import the emitted barrel references an undeclared type and
    // the generated project fails to compile.
    expect(renderModuleBarrel(['user'])).toContain(
      "import type { Constructor } from '@setu-ts/common';",
    );
  });

  it('keeps legacy controller and service exports while a project migrates', () => {
    const source = renderModuleBarrel(['orders'], ['users']);

    expect(source).toContain("import { UsersController } from './users/users.controller.ts';");
    expect(source).toContain("import { UsersService } from './users/users.service.ts';");
    expect(source).toContain("import { OrdersModule } from './orders/orders.module.ts';");
    expect(source).toContain(
      `export const ${LEGACY_CONTROLLERS_EXPORT}: readonly Constructor[] = [`,
    );
    expect(source).toContain(
      `export const ${LEGACY_SERVICES_EXPORT}: readonly Constructor[] = [`,
    );
    expect(source).toContain('UsersController');
    expect(source).toContain('OrdersController');
    expect(source).toContain('UsersService');
    expect(source).toContain('OrdersService');
  });
});
