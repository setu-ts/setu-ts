import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generatePlugin } from '../../../src/schematics/plugin.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('plugin schematic', () => {
  const files = generatePlugin(deriveNames('order-item'), options());
  const file = artifactOf(files, 'plugin');

  it('emits the plugin plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/plugins/order-item.plugin.ts',
      'src/plugins/index.ts',
    ]);
  });

  // `.plugin.ts`, not the bare `.ts` this schematic wrote before the seam existed: the
  // barrel is regenerated from a directory scan, and a suffix of `.ts` would admit any
  // module a developer put here — the barrel would then import a `<Pascal>Plugin` symbol
  // they never wrote, and their project would fail to compile naming a file they never
  // generated.
  it('emits it at src/plugins/order-item.plugin.ts, a scannable suffix', () => {
    expect(file.path).toBe('src/plugins/order-item.plugin.ts');
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('plugin', 'order-item', ['gizmo', 'billing']);
  });

  it('spreads constructed plugins from the barrel', () => {
    const barrel = barrelOf(files, 'plugin').contents;
    expect(barrel).toContain('readonly IPlugin[]');
    // Called, not referenced: `createApplication` takes plugin instances.
    expect(barrel).toContain('OrderItemPlugin()');
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
