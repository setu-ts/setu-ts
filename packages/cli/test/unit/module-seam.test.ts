import { describe, expect, it } from 'vitest';

import { getTemplate } from '../../src/templates/registry.ts';
import { renderModuleBarrel } from '../../src/schematics/module-barrel.ts';
import { withDecoratorSeams } from '../../src/templates/module-seam.ts';
import { DI_WIRING } from '../../src/templates/di.ts';

describe('module generation styles', () => {
  it('starts the class-based template flat: no module barrel and no MODULES wiring', () => {
    // The first `setu g module` writes src/modules/index.ts and switches the config.
    const template = getTemplate('class-based')!;
    const paths = (template.files ?? []).map((file) => file.path);
    expect(paths).not.toContain('src/modules/index.ts');
    expect(template.localImports ?? []).not.toContainEqual(
      expect.objectContaining({ from: './src/modules/index.ts' }),
    );
    expect(
      template.plugins.find((plugin) => plugin.pkg === 'decorator-plugin')?.args,
    ).not.toContain('MODULES');
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
    const wiring = withDecoratorSeams(
      [DI_WIRING, { pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' }],
      ['AController', 'BController', 'CController', 'DController'],
      ['AService', 'BService', 'CService', 'DService'],
    );

    expect(wiring[0]).toBe(DI_WIRING);
    expect(wiring[1].args).not.toContain('MODULES');
    expect(wiring[1].args).toContain('\n        controllers:');
  });

  it('keeps the empty class aggregate registration on one line', () => {
    const [wiring] = withDecoratorSeams([{ pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' }]);

    expect(wiring.args).toBe('{ controllers: [], services: [], ingress: [] }');
  });
});
