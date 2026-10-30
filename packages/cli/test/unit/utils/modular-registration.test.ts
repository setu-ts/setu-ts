import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { projectFiles, resolveHost } from '../../../src/templates/project-files.ts';
import { FULL_STACK_TEMPLATE } from '../../../src/templates/full-stack.ts';
import { MICROSERVICE_TEMPLATE } from '../../../src/templates/microservice.ts';
import { REST_TEMPLATE } from '../../../src/templates/rest.ts';
import type { TemplateHost } from '../../../src/templates/registry.ts';
import { TARGET_RUNTIMES, type TargetRuntime } from '../../../src/constants.ts';
import {
  modularRegistrationGuidance,
  withModularRegistration,
} from '../../../src/utils/modular-registration.ts';

/** The five generated configurations: full-stack is functional-only (`templates/choice.ts`). */
const CONFIGS: readonly (readonly [string, TemplateHost, 'functional' | 'class-based'])[] = [
  ['rest', REST_TEMPLATE, 'functional'],
  ['rest --style class-based', REST_TEMPLATE.classBased!, 'class-based'],
  ['microservice', MICROSERVICE_TEMPLATE, 'functional'],
  ['microservice --style class-based', MICROSERVICE_TEMPLATE.classBased!, 'class-based'],
  ['full-stack', FULL_STACK_TEMPLATE, 'functional'],
];

function config(host: TemplateHost, runtime: TargetRuntime = 'node'): string {
  return projectFiles('svc', runtime, resolveHost(host, runtime)).find(
    (file) => file.path === 'setu.config.ts',
  )!.contents;
}

/** Replaces one whole line, keeping its indentation; the line must occur exactly once. */
function line(source: string, from: string, to: string | null): string {
  const lines = source.split('\n');
  const found = lines.flatMap((text, index) => (text.trim() === from ? [index] : []));
  expect(found, from).toHaveLength(1);
  const indent = /^\s*/.exec(lines[found[0]!]!)![0];
  if (to === null) lines.splice(found[0]!, 1);
  else lines[found[0]!] = `${indent}${to}`;
  return lines.join('\n');
}

function syntaxErrors(source: string): readonly ts.Diagnostic[] {
  return (
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    }).diagnostics ?? []
  );
}

describe('withModularRegistration', () => {
  it('switches each of the five generated configurations on every runtime, and nothing else', () => {
    for (const runtime of TARGET_RUNTIMES)
      for (const [name, host, mode] of CONFIGS) {
        const label = `${name} on ${runtime}`;
        const original = config(host, runtime);
        // A fresh project starts flat: nothing about modules is scaffolded.
        expect(original, label).not.toContain('src/modules/index.ts');
        let expected =
          mode === 'functional'
            ? line(
                original,
                "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
                "import { registerModules } from './src/modules/index.ts';",
              )
            : line(
                line(
                  line(
                    line(
                      original,
                      "import { APP_CONTROLLERS, registerGeneratedRoutes } from './src/controllers/index.ts';",
                      "import { MODULES, registerModules } from './src/modules/index.ts';",
                    ),
                    "import { APP_SERVICES } from './src/services/index.ts';",
                    null,
                  ),
                  'controllers: [...APP_CONTROLLERS],',
                  'modules: [...MODULES],',
                ),
                'services: [...APP_SERVICES],',
                null,
              );
        expected = line(
          expected,
          'registerGeneratedRoutes(app.router, app.services);',
          'registerModules(app.router, app.services);',
        );
        const edited = withModularRegistration(original, mode);
        expect(edited, label).toBe(expected);
        expect(syntaxErrors(edited!), label).toEqual([]);
      }
  });

  it('keeps registration the config already has for modules', () => {
    const original = config(REST_TEMPLATE.classBased!);
    const partly = line(
      line(
        original,
        "import { APP_SERVICES } from './src/services/index.ts';",
        "import { APP_SERVICES } from './src/services/index.ts';\nimport { MODULES } from './src/modules/index.ts';",
      ),
      'services: [...APP_SERVICES],',
      'services: [...APP_SERVICES],\n        modules: [...MODULES],',
    );
    const edited = withModularRegistration(partly, 'class-based')!;
    expect(edited.match(/modules: \[\.\.\.MODULES\]/g)).toHaveLength(1);
    expect(edited).toContain("import { MODULES, registerModules } from './src/modules/index.ts';");
    expect(edited).not.toContain('APP_');
    const functional = config(REST_TEMPLATE);
    const both = line(
      line(
        functional,
        "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
        "import { registerGeneratedRoutes } from './src/controllers/index.ts';\nimport { registerModules } from './src/modules/index.ts';",
      ),
      'registerGeneratedRoutes(app.router, app.services);',
      'registerGeneratedRoutes(app.router, app.services);\n  registerModules(app.router, app.services);',
    );
    const switched = withModularRegistration(both, 'functional')!;
    expect(switched.match(/registerModules\(app\.router/g)).toHaveLength(1);
    expect(switched.match(/from '\.\/src\/modules\/index\.ts'/g)).toHaveLength(1);
    expect(switched).not.toContain('registerGeneratedRoutes');
  });

  it('keeps CRLF line endings on the lines it replaces', () => {
    const crlf = config(REST_TEMPLATE).replaceAll('\n', '\r\n');
    const edited = withModularRegistration(crlf, 'functional')!;
    expect(edited).toContain("import { registerModules } from './src/modules/index.ts';\r\n");
    expect(edited.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('declines every shape it cannot switch exactly', () => {
    const functional = config(REST_TEMPLATE);
    const classBased = config(REST_TEMPLATE.classBased!);
    const declined: readonly (readonly [string, string, 'functional' | 'class-based'])[] = [
      [
        'a commented-out call',
        functional.replace(
          '  registerGeneratedRoutes(app.router, app.services);',
          '  // registerGeneratedRoutes(app.router, app.services);',
        ),
        'functional',
      ],
      [
        'a second call',
        functional.replace(
          '  registerGeneratedRoutes(app.router, app.services);',
          '  registerGeneratedRoutes(app.router, app.services);\n  registerGeneratedRoutes(app.router, app.services);',
        ),
        'functional',
      ],
      [
        'a flat binding used elsewhere',
        classBased.replace('  return app;', '  void APP_CONTROLLERS;\n  return app;'),
        'class-based',
      ],
      ['an unclassifiable config', `const t = \`x\`;\n${functional}`, 'functional'],
      [
        'a missing services option',
        classBased.replace('        services: [...APP_SERVICES],\n', ''),
        'class-based',
      ],
      [
        'two modules imports',
        `${functional}import { registerModules } from './src/modules/index.ts';\nimport { registerModules } from './src/modules/index.ts';\n`,
        'functional',
      ],
    ];
    for (const [label, source, mode] of declined)
      expect(withModularRegistration(source, mode), label).toBeUndefined();
  });

  it('names the lines to change by hand for each style', () => {
    expect(modularRegistrationGuidance('functional')).toEqual({
      remove: [
        "import { registerGeneratedRoutes } from './src/controllers/index.ts';",
        'registerGeneratedRoutes(app.router, app.services);',
      ],
      add: [
        "import { registerModules } from './src/modules/index.ts';",
        'registerModules(app.router, app.services);',
      ],
    });
    expect(modularRegistrationGuidance('class-based').remove).toContain(
      "import { APP_SERVICES } from './src/services/index.ts';",
    );
    expect(modularRegistrationGuidance('class-based').add).toContain(
      "import { MODULES, registerModules } from './src/modules/index.ts';",
    );
  });
});
