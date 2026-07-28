import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateController } from '../../../src/schematics/controller.ts';
import { gateOf, options } from './_shared.ts';

describe('controller schematic', () => {
  const files = generateController(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/controllers/order-item.controller.ts', () => {
    expect(file.path).toBe('src/controllers/order-item.controller.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is ungated', () => {
    expect(gateOf('controller')).toBe(undefined);
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateController(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the route prefix and class name', () => {
    expect(file.contents).toContain("@Controller('/order-item')");
    expect(file.contents).toContain('export class OrderItemController');
  });

  it('imports the decorators it uses as values and the types as types', () => {
    expect(file.contents).toContain(
      "import { Controller, Get, Post } from '@hono-enterprise/decorator-plugin';",
    );
    expect(file.contents).toContain(
      "import type { HandlerResult, IRequestContext } from '@hono-enterprise/common';",
    );
  });
});
