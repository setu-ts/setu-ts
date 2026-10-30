import { describe, expect, it } from 'vitest';

import { viewRegistrationAdvice } from '../../../src/commands/add.ts';
import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../../src/templates/rest.ts';
import { withModularRegistration } from '../../../src/utils/modular-registration.ts';

const FLAT = projectFiles('svc', 'node', resolveHost(REST_TEMPLATE, 'node')).find(
  (file) => file.path === 'setu.config.ts',
)!.contents;
const IMPORT = "import { registerGeneratedRoutes } from './src/controllers/index.ts';";
const CALL = '  registerGeneratedRoutes(app.router, app.services);\n';

describe('viewRegistrationAdvice', () => {
  it('says what to change for each way the registration can be missing', () => {
    const cases: readonly (readonly [
      string,
      string | undefined,
      string | undefined,
      readonly string[],
    ])[] = [
      ['a wired flat config', FLAT, undefined, []],
      ['a modular config', withModularRegistration(FLAT, 'functional')!, 'shop', []],
      [
        'an import with the call outside the factory',
        `${FLAT.replace(CALL, '')}\nexport function later(app: IKernelApplication): void {\n${CALL}}\n`,
        undefined,
        [
          'setu.config.ts does not call registerGeneratedRoutes, so /ui is not registered; add:',
          '  registerGeneratedRoutes(app.router, app.services);',
        ],
      ],
      [
        'neither the import nor the call',
        FLAT.replace(CALL, '').replace(`${IMPORT}\n`, ''),
        undefined,
        [
          'setu.config.ts does not call registerGeneratedRoutes, so /ui is not registered; add:',
          `  ${IMPORT}`,
          '  registerGeneratedRoutes(app.router, app.services);',
        ],
      ],
      [
        'the registrar imported from the pre-M70h routes barrel',
        FLAT.replace("'./src/controllers/index.ts'", "'./src/routes/index.ts'"),
        undefined,
        [
          'setu.config.ts imports registerGeneratedRoutes from ./src/routes/index.ts, but /ui is registered through ./src/controllers/index.ts; import it from there:',
          `  ${IMPORT}`,
        ],
      ],
      [
        'an unclassifiable config',
        `const note = \`x\`;\n${FLAT}`,
        undefined,
        [
          'Cannot verify that setu.config.ts calls registerGeneratedRoutes, which registers /ui; it needs:',
          `  ${IMPORT}`,
          '  registerGeneratedRoutes(app.router, app.services);',
        ],
      ],
      [
        'a modular config that never calls registerModules',
        withModularRegistration(FLAT, 'functional')!.replace(
          '  registerModules(app.router, app.services);\n',
          '',
        ),
        'shop',
        [
          'setu.config.ts does not call registerModules, so /ui is not registered; add:',
          '  registerModules(app.router, app.services);',
        ],
      ],
    ];
    const aliased = FLAT.replace(
      IMPORT,
      "import { registerGeneratedRoutes as wireRoutes } from './src/controllers/index.ts';",
    ).replace('  registerGeneratedRoutes(app.router', '  wireRoutes(app.router');
    const more: typeof cases = [
      ['an aliased import called by its local name', aliased, undefined, []],
      [
        'no setu.config.ts',
        undefined,
        'shop',
        [
          'No setu.config.ts: where the application is composed, register /ui with:',
          "  import { registerModules } from './src/modules/index.ts';",
          '  registerModules(app.router, app.services);',
        ],
      ],
    ];
    for (const [label, config, module, expected] of [...cases, ...more])
      expect(viewRegistrationAdvice(config, module), label).toEqual(expected);
  });
});
