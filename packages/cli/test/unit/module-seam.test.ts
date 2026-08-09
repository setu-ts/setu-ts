/**
 * Tests for the domain-module barrel seam the templates emit.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { getTemplate } from '../../src/templates/registry.ts';
import type { Wiring } from '../../src/templates/registry.ts';
import { withModuleSeam } from '../../src/templates/module-seam.ts';
import { MODULES_DIR } from '../../src/utils/module-scanner.ts';
import { CONTROLLERS_EXPORT, SERVICES_EXPORT } from '../../src/schematics/module-barrel.ts';

/** The templates that host domain modules. */
const HOSTS = ['rest', 'microservice', 'nest'] as const;

/** Path of the aggregate barrel inside a scaffolded project. */
const BARREL = `${MODULES_DIR}/index.ts`;

describe('the module barrel seam', () => {
  for (const name of HOSTS) {
    describe(`--template ${name}`, () => {
      it('emits the aggregate barrel from scaffold time', () => {
        // Emitted up front, so `setu g module` never has to edit setu.config.ts.
        const template = getTemplate(name);

        expect(template?.files?.some((f) => f.path === BARREL)).toBe(true);
      });

      it('imports both barrel arrays into setu.config.ts', () => {
        const template = getTemplate(name);

        const seam = template?.localImports?.find((i) => i.from === `./${BARREL}`);
        expect(seam).toBeDefined();
        expect(seam?.symbols).toEqual([CONTROLLERS_EXPORT, SERVICES_EXPORT]);
      });

      it('passes both arrays to DecoratorPlugin', () => {
        // `args` is a rendered string the CLI's own type-check cannot see, so a
        // wrong identifier here is a compile error only in the generated
        // project — the e2e gate is what proves it resolves.
        const decorator = getTemplate(name)?.plugins.find((p) => p.pkg === 'decorator-plugin');

        expect(decorator?.args).toContain(`...${CONTROLLERS_EXPORT}`);
        expect(decorator?.args).toContain(`...${SERVICES_EXPORT}`);
      });

      it('declares the seam file exactly once', () => {
        const paths = getTemplate(name)?.files?.filter((f) => f.path === BARREL) ?? [];

        // A duplicate path would trip the new-command collision check.
        expect(paths.length).toBe(1);
      });
    });
  }

  it('keeps the nest template naming its own example classes', () => {
    // The seam spreads the barrel arrays; it must not displace the classes the
    // nest template emits and imports.
    const decorator = getTemplate('nest')?.plugins.find((p) => p.pkg === 'decorator-plugin');

    expect(decorator?.args).toContain('GreetingController');
    expect(decorator?.args).toContain('GreetingService');
  });

  it('leaves full-stack without the seam', () => {
    // Its layering is routes → features → services (M36c); it has no
    // src/modules/ concept, and `g module` is not offered for it.
    const template = getTemplate('full-stack');

    expect(template?.files?.some((f) => f.path === BARREL)).toBe(false);
    expect(template?.localImports?.some((i) => i.from === `./${BARREL}`)).toBe(false);
  });

  it('starts the barrel empty', () => {
    const seam = getTemplate('rest')?.files?.find((f) => f.path === BARREL);

    expect(seam?.contents).toContain(
      `export const ${CONTROLLERS_EXPORT}: readonly Constructor[] = [];`,
    );
  });

  // The emitted `setu.config.ts` is a file a developer opens and edits, so the decorator
  // wiring wraps once it would run long. Both arms are exercised here because no shipped
  // template takes the inline one any more — every host now names the standalone barrels
  // alongside the module ones, which pushes the single-line form past the threshold.
  describe('the decorator args wrap', () => {
    const decoratorOf = (wirings: readonly Wiring[]) =>
      wirings.find((w) => w.pkg === 'decorator-plugin')?.args;
    const WIRINGS: readonly Wiring[] = [{ pkg: 'decorator-plugin', symbol: 'DecoratorPlugin' }];

    it('stays inline when only the module barrels are named', () => {
      // The pre-seam shape: short enough to read on one line, so it is left there.
      expect(decoratorOf(withModuleSeam(WIRINGS))).toBe(
        `{ controllers: [...${CONTROLLERS_EXPORT}], services: [...${SERVICES_EXPORT}] }`,
      );
    });

    it('breaks across lines once more sources are named', () => {
      const args = decoratorOf(
        withModuleSeam(WIRINGS, ['...APP_CONTROLLERS'], ['...APP_SERVICES']),
      );

      expect(args).toContain('{\n');
      // Indented to sit inside the plugin-array entry the renderer already indented by
      // six, and closed at that same six.
      expect(args).toContain(
        `\n        controllers: [...APP_CONTROLLERS, ...${CONTROLLERS_EXPORT}],\n`,
      );
      expect(args?.endsWith('\n      }')).toBe(true);
    });

    it('leaves a wiring that is not the decorator plugin untouched', () => {
      const others: readonly Wiring[] = [{ pkg: 'logger-plugin', symbol: 'LoggerPlugin' }];
      expect(withModuleSeam(others)).toEqual(others);
    });
  });
});
