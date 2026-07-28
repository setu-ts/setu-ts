import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateGuard } from '../../../src/schematics/guard.ts';
import { gateOf, options } from './_shared.ts';

describe('guard schematic', () => {
  const files = generateGuard(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/guards/order-item.guard.ts', () => {
    expect(file.path).toBe('src/guards/order-item.guard.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on auth-plugin', () => {
    expect(gateOf('guard')).toBe('auth-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateGuard(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('exports the require<Pascal> factory', () => {
    expect(file.contents).toContain('export function requireOrderItem(): MiddlewareFunction');
  });

  it('short-circuits without calling next on both failure paths', () => {
    const before = file.contents.indexOf('await next();');
    expect(file.contents.slice(0, before)).toContain('status(401)');
    expect(file.contents.slice(0, before)).toContain('status(403)');
  });
});
