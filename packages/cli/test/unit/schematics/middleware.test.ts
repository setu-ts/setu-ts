import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMiddleware } from '../../../src/schematics/middleware.ts';
import { gateOf, options } from './_shared.ts';

describe('middleware schematic', () => {
  const files = generateMiddleware(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
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
