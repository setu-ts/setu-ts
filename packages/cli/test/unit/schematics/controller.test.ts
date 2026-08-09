import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateController } from '../../../src/schematics/controller.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('controller schematic', () => {
  const files = generateController(deriveNames('order-item'), options());
  const file = artifactOf(files, 'controller');

  it('emits the controller plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/controllers/order-item.controller.ts',
      'src/controllers/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('controller', 'order-item', ['gizmo', 'billing']);
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
    const pascal = generateController(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the route prefix and class name', () => {
    expect(file.contents).toContain("@Controller('/order-item')");
    expect(file.contents).toContain('export class OrderItemController');
  });

  it('imports the decorators it uses', () => {
    expect(file.contents).toContain(
      "import { Body, Controller, Get, Post } from '@setu-ts/decorator-plugin';",
    );
  });

  it('declares no request-context parameter on a handler', () => {
    // This assertion previously pinned the OPPOSITE — it required the
    // `IRequestContext` import — which is how a controller that answered 500 on
    // every request stayed "covered". The plugin builds a handler's arguments from
    // parameter metadata alone and never passes the context positionally, so a
    // `ctx` parameter arrives `undefined` and the first `ctx.response` throws.
    // The e2e that boots a scaffolded app is the real proof; this is the fast one.
    expect(file.contents).not.toContain('IRequestContext');
    expect(file.contents).not.toContain('ctx.response');
  });
});
