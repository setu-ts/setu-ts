import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { getTemplate } from '../../src/templates/registry.ts';
import { renderModuleBarrel } from '../../src/schematics/module-barrel.ts';

describe('module generation styles', () => {
  it('keeps the module barrel and decorator registration in the class-based template', () => {
    const template = getTemplate('class-based')!;
    const paths = (template.files ?? []).map((file) => file.path);
    expect(paths).toContain('src/modules/index.ts');
    expect(template.localImports).toContainEqual({
      symbols: ['MODULE_CONTROLLERS', 'MODULE_SERVICES'],
      from: './src/modules/index.ts',
    });
    expect(template.plugins.find((plugin) => plugin.pkg === 'decorator-plugin')?.args)
      .toContain('...MODULE_CONTROLLERS');
  });

  it('keeps functional templates free of class module wiring', () => {
    for (const name of ['rest', 'microservice'] as const) {
      const template = getTemplate(name)!;
      expect((template.files ?? []).map((file) => file.path)).not.toContain('src/modules/index.ts');
      expect(template.plugins.some((plugin) => plugin.pkg === 'decorator-plugin')).toBe(false);
    }
  });

  it('starts the class-based module barrel empty', () => {
    expect(renderModuleBarrel([])).toContain('export const MODULE_CONTROLLERS');
    expect(renderModuleBarrel([])).toContain('export const MODULE_SERVICES');
  });
});
