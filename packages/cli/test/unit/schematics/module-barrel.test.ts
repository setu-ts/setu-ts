/**
 * Unit tests for the aggregate module barrel renderer.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  CONTROLLERS_EXPORT,
  renderModuleBarrel,
  SERVICES_EXPORT,
} from '../../../src/schematics/module-barrel.ts';

describe('renderModuleBarrel', () => {
  it('emits both arrays empty for a project with no modules', () => {
    const source = renderModuleBarrel([]);

    expect(source).toContain(`export const ${CONTROLLERS_EXPORT}: readonly Constructor[] = [];`);
    expect(source).toContain(`export const ${SERVICES_EXPORT}: readonly Constructor[] = [];`);
    // No module imports at all — only the type import.
    expect(source).not.toContain('.controller.ts');
  });

  it('imports and lists a controller and service per module', () => {
    const source = renderModuleBarrel(['user']);

    expect(source).toContain(
      "import { UserController } from './user/user.controller.ts';",
    );
    expect(source).toContain("import { UserService } from './user/user.service.ts';");
    expect(source).toContain(`export const ${CONTROLLERS_EXPORT}: readonly Constructor[] = [`);
    expect(source).toContain('UserController');
    expect(source).toContain('UserService');
  });

  it('derives PascalCase class names from a multi-word kebab directory', () => {
    const source = renderModuleBarrel(['order-item']);

    expect(source).toContain(
      "import { OrderItemController } from './order-item/order-item.controller.ts';",
    );
    expect(source).toContain('OrderItemController');
  });

  it('sorts modules so enumeration order cannot change the output', () => {
    // `readdir` order is filesystem-defined. Without the sort, two machines
    // holding identical modules would render byte-different barrels and a
    // no-op regeneration would show up as a diff.
    const forward = renderModuleBarrel(['user', 'order', 'billing']);
    const reversed = renderModuleBarrel(['billing', 'user', 'order']);

    expect(forward).toBe(reversed);
    expect(forward.indexOf('BillingController')).toBeLessThan(
      forward.indexOf('OrderController'),
    );
    expect(forward.indexOf('OrderController')).toBeLessThan(forward.indexOf('UserController'));
  });

  it('lists a duplicated module name exactly once', () => {
    // The schematic unions the existing set with the new name, so a regeneration
    // over an existing module passes that name twice.
    const source = renderModuleBarrel(['user', 'user']);

    expect(source.match(/UserController/g)?.length).toBe(2); // one import, one array entry
    expect(source.match(/from '\.\/user\/user\.controller\.ts'/g)?.length).toBe(1);
  });

  it('breaks a long array onto indented lines', () => {
    const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

    const source = renderModuleBarrel(many);

    expect(source).toContain(`export const ${CONTROLLERS_EXPORT}: readonly Constructor[] = [\n`);
    expect(source).toContain('  AlphaController,\n');
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
});
