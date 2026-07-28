import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generatePlugin } from '../../../src/schematics/plugin.ts';
import { gateOf, options } from './_shared.ts';

describe('plugin schematic', () => {
  const files = generatePlugin(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/plugins/order-item.ts', () => {
    expect(file.path).toBe('src/plugins/order-item.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is ungated', () => {
    expect(gateOf('plugin')).toBe(undefined);
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generatePlugin(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('declares the plugin factory and its kebab-case name', () => {
    expect(file.contents).toContain('export function OrderItemPlugin(): IPlugin');
    expect(file.contents).toContain("name: 'order-item',");
  });

  it('registers the token it declares in provides', () => {
    expect(file.contents).toContain("createCapabilityToken('order-item')");
    expect(file.contents).toContain('provides: [ORDER_ITEM]');
    expect(file.contents).toContain('ctx.services.register(ORDER_ITEM, service)');
  });
});
