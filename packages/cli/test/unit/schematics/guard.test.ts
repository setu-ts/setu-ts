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

  it('delegates the real permission decision and response to auth-plugin', () => {
    expect(file.contents).toContain("import { requirePermission } from '@setu-ts/auth-plugin';");
    expect(file.contents).toContain("return requirePermission('order-item');");
    expect(file.contents).not.toContain('allowed = true');
    expect(file.contents).not.toContain('json({ error:');
  });

  it('names the rbac option it depends on and the 501 it answers without one', () => {
    // Without an authorization service requirePermission fails closed with
    // 501 for every authenticated caller; the guard must say how to avoid it.
    expect(file.contents).toContain('registers only when given an `rbac` option');
    expect(file.contents).toContain('every authenticated request answers `501`');
    expect(file.contents).toContain("rbac: { roles: { admin: { permissions: ['order-item'] } } },");
  });
});
