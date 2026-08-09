import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMiddleware } from '../../../src/schematics/middleware.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('middleware schematic', () => {
  const files = generateMiddleware(deriveNames('order-item'), options());
  const file = artifactOf(files, 'middleware');

  it('emits the middleware plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/middleware/order-item.middleware.ts',
      'src/middleware/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('middleware', 'order-item', ['gizmo', 'billing']);
  });

  // The pipeline position lives in the developer's own module, not in the CLI-owned
  // barrel, so changing it survives the next regeneration. `500` is the kernel default,
  // so a generated middleware lands exactly where a bare `add()` would have put it.
  it('declares its priority in its own module, and the barrel reads it', () => {
    expect(file.contents).toContain('export const ORDER_ITEM_MIDDLEWARE_PRIORITY = 500;');
    const barrel = barrelOf(files, 'middleware').contents;
    expect(barrel).toContain('priority: ORDER_ITEM_MIDDLEWARE_PRIORITY,');
    expect(barrel).toContain("name: 'order-item',");
    // Never a literal: a hardcoded number here would silently override the developer's.
    expect(barrel).not.toContain('priority: 500');
  });

  it('emits it at src/middleware/order-item.middleware.ts', () => {
    expect(file.path).toBe('src/middleware/order-item.middleware.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is ungated', () => {
    expect(gateOf('middleware')).toBe(undefined);
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateMiddleware(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('exports a camelCase factory returning a MiddlewareFunction', () => {
    expect(file.contents).toContain('export function orderItemMiddleware(): MiddlewareFunction');
  });

  it('calls next()', () => {
    expect(file.contents).toContain('await next();');
  });
});
