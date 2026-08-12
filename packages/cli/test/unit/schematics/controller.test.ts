import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateController } from '../../../src/schematics/controller.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('controller schematic', () => {
  const files = generateController(
    deriveNames('order-item'),
    options(['decorator-plugin', 'di-plugin']),
  );
  const file = artifactOf(files, 'controller');

  it('emits the controller plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/controllers/order-item.controller.ts',
      'src/controllers/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('controller', 'order-item', ['gizmo', 'billing'], {
      plugins: ['decorator-plugin', 'di-plugin'],
    });
  });

  it('lists the class in the barrel for DecoratorPlugin({ controllers })', () => {
    expect(barrelOf(files, 'controller').contents).toContain('OrderItemController');
    expect(barrelOf(files, 'controller').contents).toContain('readonly Constructor[]');
  });

  it('emits it at src/controllers/order-item.controller.ts', () => {
    expect(file.path).toBe('src/controllers/order-item.controller.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on decorator-plugin', () => {
    // The emitted class uses @Controller/@Get/@Post.
    expect(gateOf('controller')).toBe('decorator-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateController(
      deriveNames('OrderItem'),
      options(['decorator-plugin', 'di-plugin']),
    );
    expect(pascal).toEqual(files);
  });

  it('declares the route prefix and class name', () => {
    expect(file.contents).toContain("@Controller('/order-item')");
    expect(file.contents).toContain('export class OrderItemController');
  });

  it('imports the decorators it uses', () => {
    expect(file.contents).toContain(
      "import { Body, Controller, Ctx, Get, Post } from '@setu-ts/decorator-plugin';",
    );
  });

  it('uses the built-in context decorator for a status-sensitive write handler', () => {
    expect(file.contents).toContain('import type { IRequestContext }');
    expect(file.contents).toContain('@Ctx() ctx: IRequestContext');
    expect(file.contents).toContain('ctx.response.status(201)');
  });
});
