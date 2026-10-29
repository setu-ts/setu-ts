import { describe, expect, it } from 'vitest';
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

  it('names both ways the barrel is consumed, and never claims it is wired', () => {
    expect(barrelOf(files, 'controller').contents).not.toContain('needs no further wiring');
    expect(file.contents).not.toContain('needs no further wiring');
    expect(file.contents).toContain('DecoratorPlugin({ controllers: [...APP_CONTROLLERS] })');
    expect(file.contents).toContain('decorators: { controllers:');
    expect(barrelOf(files, 'controller').contents).toContain('decorators: { controllers:');
  });

  it('emits it at src/controllers/order-item.controller.ts', () => {
    expect(file.path).toBe('src/controllers/order-item.controller.ts');
  });

  it('is UNGATED, and shaped by the project instead', () => {
    // E8: the gate existed because the emitted class imports
    // `@setu-ts/decorator-plugin`. With both HTTP kinds sharing one directory
    // there is no second directory to redirect to, so the schematic branches on
    // generator mode — like `service` — and a bare project gets a function
    // whose imports resolve.
    expect(gateOf('controller')).toBeUndefined();
  });

  it('declares the route prefix and class name', () => {
    expect(file.contents).toContain("@Controller('/order-item')");
    expect(file.contents).toContain('export class OrderItemController');
  });

  it('imports the decorators it uses', () => {
    expect(file.contents).toContain(
      "import { Body, Controller, Ctx, Get, Params, Post } from '@setu-ts/decorator-plugin';",
    );
  });

  it('binds the request context positionally for a status-sensitive write handler', () => {
    // Under TC39 standard decorators there is no parameter position, so the
    // context is declared as a source in @Params rather than on the parameter.
    expect(file.contents).toContain('import type { IRequestContext }');
    expect(file.contents).toContain('@Params(Body<Record<string, unknown>>(), Ctx())');
    expect(file.contents).toContain('create(body: Record<string, unknown>, ctx: IRequestContext)');
    expect(file.contents).toContain('ctx.response.status(201)');
    // The legacy parameter form must not reappear: it is a PARSE error without
    // a compiler option this project no longer sets.
    expect(file.contents).not.toContain('@Ctx() ctx');
    expect(file.contents).not.toContain('@Body() body');
  });
});
