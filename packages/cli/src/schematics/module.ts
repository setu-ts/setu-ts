/** Domain-module schematic for both application styles. @module */
import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import { MODULES_DIR } from '../utils/module-scanner.ts';
import { renderModuleBarrel } from './module-barrel.ts';
import { renderFunctionalModuleBarrel, renderFunctionalModuleIndex } from '../seams/modules.ts';
import { moduleService, moduleRoutes, moduleSchemas, moduleController } from './module-files.ts';
import { renderModuleTest, renderModuleE2e, renderTestServer } from './test-harness.ts';

function classModule(names: DerivedNames): string {
  return `import { Module } from '@setu-ts/decorator-plugin';

import { ${names.pascal}Controller } from './${names.kebab}.controller.ts';
import { ${names.pascal}Service } from './${names.kebab}.service.ts';

/**
 * The ${names.kebab} module.
 *
 * Add controllers and providers here. The CLI never rewrites this declaration;
 * importing another module activates its controllers and providers too.
 */
@Module({
  controllers: [${names.pascal}Controller],
  providers: [${names.pascal}Service],
})
export class ${names.pascal}Module {}
`;
}

function classIndex(names: DerivedNames): string {
  return `export { ${names.pascal}Controller } from './${names.kebab}.controller.ts';
export { ${names.pascal}Module } from './${names.kebab}.module.ts';
export { ${names.pascal}Service } from './${names.kebab}.service.ts';
`;
}

/** The renderer has no time-dependent output; schematic callers may still supply their clock. */
type ModuleOptions = Omit<SchematicOptions, 'now'> & Partial<Pick<SchematicOptions, 'now'>>;

/** Generates the feature files and its managed activation barrel. */
export function generateModule(
  names: DerivedNames,
  options: ModuleOptions,
): readonly GeneratedFile[] {
  const dir = `${MODULES_DIR}/${names.kebab}`;
  const classBased = generatorMode(options.plugins) === 'class-based';
  const validation = options.plugins.has('validation-plugin');
  const exceptions = options.plugins.has('exceptions');
  const files: GeneratedFile[] = [
    {
      path: `${dir}/${names.kebab}.service.ts`,
      contents: moduleService(names, validation, classBased),
    },
    {
      path: `${dir}/${names.kebab}.${classBased ? 'controller' : 'routes'}.ts`,
      contents: classBased
        ? moduleController(names, validation, exceptions)
        : moduleRoutes(names, validation, exceptions),
    },
    ...(classBased
      ? [{ path: `${dir}/${names.kebab}.module.ts`, contents: classModule(names) }]
      : []),
    {
      path: `${dir}/index.ts`,
      contents: classBased
        ? classIndex(names)
        : renderFunctionalModuleIndex(names, { route: [names.kebab] }),
      ...(classBased ? {} : { managed: true }),
    },
    {
      path: `${MODULES_DIR}/index.ts`,
      managed: true,
      contents: classBased
        ? renderModuleBarrel([...(options.modules ?? []), names.kebab], options.legacyModules)
        : renderFunctionalModuleBarrel([...(options.modules ?? []), names.kebab]),
    },
    ...(validation
      ? [{ path: `${dir}/${names.kebab}.schemas.ts`, contents: moduleSchemas(names) }]
      : []),
  ];
  if (options.runtime !== 'cloudflare-workers') {
    files.push(
      { path: `${dir}/${names.kebab}.test.ts`, contents: renderModuleTest(names, options.runtime) },
      {
        path: `${dir}/${names.kebab}.e2e.test.ts`,
        contents: renderModuleE2e(
          names,
          options.runtime,
          validation,
          options.plugins.has('openapi-plugin'),
        ),
      },
      { path: 'test/support/server.ts', managed: true, contents: renderTestServer() },
    );
  }
  return files;
}
