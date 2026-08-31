import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { getTemplate } from '../../src/templates/registry.ts';
import { renderModuleBarrel } from '../../src/schematics/module-barrel.ts';
import { withModuleSeam } from '../../src/templates/module-seam.ts';
import { DI_WIRING } from '../../src/templates/di.ts';

describe('module generation styles', () => {
  it('keeps the module barrel and decorator registration in the class-based template', () => {
    const template = getTemplate('class-based')!;
    const paths = (template.files ?? []).map((file) => file.path);
    expect(paths).toContain('src/modules/index.ts');
    expect(template.localImports).toContainEqual({
      symbols: ['MODULES'],
      from: './src/modules/index.ts',
    });
    expect(template.plugins.find((plugin) => plugin.pkg === 'decorator-plugin')?.args)
      .toContain('...MODULES');
  });

  it('keeps functional templates free of class module wiring', () => {
    for (const name of ['rest', 'microservice'] as const) {
      const template = getTemplate(name)!;
      expect((template.files ?? []).map((file) => file.path)).not.toContain('src/modules/index.ts');
      expect(template.plugins.some((plugin) => plugin.pkg === 'decorator-plugin')).toBe(false);
    }
  });

  it('starts the class-based module barrel empty', () => {
    expect(renderModuleBarrel([])).toContain('export const MODULES');
  });

  it('rewrites only the decorator wiring and wraps long module registration', () => {
    const wiring = withModuleSeam(
      [DI_WIRING, { pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' }],
      ['AController', 'BController', 'CController', 'DController'],
      ['AService', 'BService', 'CService', 'DService'],
    );

    expect(wiring[0]).toBe(DI_WIRING);
    expect(wiring[1].args).toContain('...MODULES');
    expect(wiring[1].args).toContain('\n        controllers:');
  });

  it('keeps the empty class aggregate registration on one line', () => {
    const [wiring] = withModuleSeam([{ pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' }]);

    expect(wiring.args).toBe(
      '{ controllers: [], services: [], modules: [...MODULES] }',
    );
  });
});
