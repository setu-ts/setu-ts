/**
 * Domain-module schematic for functional and class-based applications.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { FUNCTIONAL_ROUTES_SEAM, HTTP_SEAM_DIR } from '../seams/http.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import { renderEquals, testHarnessFor } from './test-harness.ts';
import type { TargetRuntime } from '../constants.ts';
import { MODULES_DIR } from '../utils/module-scanner.ts';
import { renderModuleBarrel } from './module-barrel.ts';

function serviceToken(names: DerivedNames): string {
  return `${names.kebab}-service`;
}

function functionalService(names: DerivedNames): string {
  return `/** Lists ${names.kebab} records. */
export function list${names.pascal}(): readonly Record<string, unknown>[] {
  return [];
}
`;
}

function functionalRoutes(names: DerivedNames): string {
  return `import type { IRouterApi } from '@setu-ts/common';

import { list${names.pascal} } from '../modules/${names.kebab}/${names.kebab}.service.ts';

/** Registers the ${names.kebab} HTTP routes. */
export function register${names.pascal}Routes(router: IRouterApi): void {
  router.group('/${names.kebab}', (routes) => {
    routes.get('/', (ctx) => ctx.response.json({ items: list${names.pascal}() }));
    routes.post('/', (ctx) => ctx.response.status(201).json({ created: true }));
  });
}
`;
}

function functionalTest(names: DerivedNames, runtime: TargetRuntime): string {
  // The harness is per runtime because `@std/testing/bdd` reaches `Deno.test`
  // internally, so this file could not execute at all on a node or bun target.
  return `${testHarnessFor(runtime).imports}

import { list${names.pascal} } from './${names.kebab}.service.ts';

describe('list${names.pascal}', () => {
  it('starts with no records', () => {
    ${renderEquals(runtime, `list${names.pascal}()`, '[]')}
  });
});
`;
}

function functionalIndex(names: DerivedNames): string {
  // A star re-export, not a named one (A3). Naming the stub symbol meant that
  // replacing it — the obvious next step after generating a module — broke the
  // barrel with `TS2305: Module … has no exported member 'listX'`, and the
  // barrel is not reachable from `deno check main.ts setu.config.ts`, so it
  // stayed broken through a full green run of every gate the developer had.
  //
  // The scope is exactly the barrel, and review corrected an earlier claim that
  // this also fixed the generated test: the test and the route module import
  // `list${'$'}{Pascal}` BY NAME and should, since one exercises that function and
  // the other serves it. Renaming the stub means editing the two files that use
  // it, which is ordinary. A re-export list naming a symbol is not.
  return `export * from './${names.kebab}.service.ts';
`;
}

function classService(names: DerivedNames): string {
  return `import { Injectable } from '@setu-ts/decorator-plugin';

/** Domain service for ${names.kebab}. */
@Injectable({ token: '${serviceToken(names)}' })
export class ${names.pascal}Service {
  /** Lists ${names.kebab} records. */
  list(): readonly Record<string, unknown>[] {
    return [];
  }
}
`;
}

function classController(names: DerivedNames): string {
  return `import { Body, Controller, Ctx, Get, Inject, Params, Post } from '@setu-ts/decorator-plugin';
import type { IRequestContext } from '@setu-ts/common';

import { ${names.pascal}Service } from './${names.kebab}.service.ts';

/** HTTP controller for the ${names.kebab} resource. */
@Controller('/${names.kebab}')
@Inject('${serviceToken(names)}')
export class ${names.pascal}Controller {
  constructor(private readonly service: ${names.pascal}Service) {}

  /** Lists ${names.kebab} records. */
  @Get('/')
  list(): { readonly items: readonly Record<string, unknown>[] } {
    return { items: this.service.list() };
  }

  /** Creates a ${names.kebab} record. */
  @Post('/')
  @Params(Body<Record<string, unknown>>(), Ctx())
  create(body: Record<string, unknown>, ctx: IRequestContext): unknown {
    return ctx.response.status(201).json({ created: body });
  }
}
`;
}

function classTest(names: DerivedNames, runtime: TargetRuntime): string {
  return `${testHarnessFor(runtime).imports}

import { ${names.pascal}Service } from './${names.kebab}.service.ts';

describe('${names.pascal}Service', () => {
  it('starts with no records', () => {
    ${renderEquals(runtime, `new ${names.pascal}Service().list()`, '[]')}
  });
});
`;
}

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

/**
 * Generates a complete domain aggregate in the target project's selected style.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Detected packages, module names, and existing route artifacts
 * @returns Files that implement and register the domain aggregate
 */
export function generateModule(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const dir = `${MODULES_DIR}/${names.kebab}`;
  if (generatorMode(options.plugins) === 'functional') {
    return [
      { path: `${dir}/${names.kebab}.service.ts`, contents: functionalService(names) },
      {
        path: `${dir}/${names.kebab}.service.test.ts`,
        contents: functionalTest(names, options.runtime),
      },
      { path: `${dir}/index.ts`, contents: functionalIndex(names) },
      {
        path: `${HTTP_SEAM_DIR}/${names.kebab}.routes.ts`,
        contents: functionalRoutes(names),
      },
      {
        path: FUNCTIONAL_ROUTES_SEAM.barrel,
        contents: FUNCTIONAL_ROUTES_SEAM.renderBarrel({
          controller: seamNames(options.artifacts, 'controller'),
          route: seamNames(options.artifacts, 'route', names.kebab),
        }),
        managed: true,
      },
    ];
  }

  return [
    { path: `${dir}/${names.kebab}.service.ts`, contents: classService(names) },
    { path: `${dir}/${names.kebab}.controller.ts`, contents: classController(names) },
    { path: `${dir}/${names.kebab}.module.ts`, contents: classModule(names) },
    { path: `${dir}/${names.kebab}.service.test.ts`, contents: classTest(names, options.runtime) },
    { path: `${dir}/index.ts`, contents: classIndex(names) },
    {
      path: `${MODULES_DIR}/index.ts`,
      contents: renderModuleBarrel(
        [...(options.modules ?? []), names.kebab],
        options.legacyModules,
      ),
      managed: true,
    },
  ];
}
