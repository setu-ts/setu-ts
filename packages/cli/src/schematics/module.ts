/**
 * Module schematic — a whole domain sub-module in one command.
 *
 * The aggregate the other thirteen schematics could not express: a controller, a
 * service, a test, a per-module barrel, and a regenerated aggregate barrel that
 * wires the module in without touching `setu.config.ts`.
 *
 * Pure, like every schematic. The existing module names it needs to render the
 * aggregate barrel arrive through `SchematicOptions.modules`, gathered by the
 * command layer — see `utils/module-scanner.ts`.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { MODULES_DIR } from '../utils/module-scanner.ts';
import { CONTROLLERS_EXPORT, renderModuleBarrel } from './module-barrel.ts';

/**
 * The capability token the module's service registers under.
 *
 * Derived from the module name rather than the class name so it is stable and
 * predictable: the controller's `@Inject` names this exact string, and an
 * explicit token is mandatory because `emitDecoratorMetadata` is absent
 * repo-wide (Deno does not support it), so the parameter's type cannot be read.
 *
 * @param names - The module's derived naming forms
 * @returns The token, e.g. `user-profile-service`
 */
function serviceToken(names: DerivedNames): string {
  return `${names.kebab}-service`;
}

/**
 * Renders the module's service class.
 *
 * @param names - The module's derived naming forms
 * @returns The file contents
 */
function renderService(names: DerivedNames): string {
  return `import { Injectable } from '@setu-ts/decorator-plugin';

/**
 * Domain service for ${names.kebab}.
 *
 * \`token\` is the name this registers under — the string the controller's
 * \`@Inject\` resolves. It works with or without \`DiPlugin\`: with a container the
 * service is constructed through it, and without one it lands in the kernel's
 * service registry.
 */
@Injectable({ token: '${serviceToken(names)}' })
export class ${names.pascal}Service {
  /**
   * Lists ${names.kebab} records.
   *
   * Replace this with a repository call — see the database plugin's
   * \`getRepository\` — or with whatever this module's data source is.
   *
   * @returns The records
   */
  list(): readonly Record<string, unknown>[] {
    return [];
  }
}
`;
}

/**
 * Renders the module's controller class.
 *
 * @param names - The module's derived naming forms
 * @returns The file contents
 */
function renderController(names: DerivedNames): string {
  return `import { Body, Controller, Get, Inject, Post } from '@setu-ts/decorator-plugin';

import { ${names.pascal}Service } from './${names.kebab}.service.ts';

/**
 * HTTP controller for the ${names.kebab} resource.
 *
 * Registered through the \`${CONTROLLERS_EXPORT}\` barrel in \`src/modules/index.ts\`,
 * which \`setu.config.ts\` passes to \`DecoratorPlugin\` — so this class needs no
 * further wiring.
 *
 * A decorated handler receives ONLY its decorated parameters: the plugin builds
 * the argument list from parameter metadata alone and never passes the request
 * context positionally, so a \`ctx\` parameter would arrive \`undefined\`. Return a
 * plain value and the plugin serializes it as JSON. Reach for
 * \`app.router.get(...)\` (see \`setu generate route\`) when a handler needs the
 * context itself — to set a status code or stream a response.
 */
@Controller('/${names.kebab}')
export class ${names.pascal}Controller {
  /**
   * @param ${names.camel}s - The domain service, injected by token
   */
  constructor(
    @Inject('${serviceToken(names)}') private readonly ${names.camel}s: ${names.pascal}Service,
  ) {}

  /**
   * Lists ${names.kebab} records.
   *
   * @returns The records, serialized as JSON
   */
  @Get('/')
  list(): { readonly items: readonly Record<string, unknown>[] } {
    return { items: this.${names.camel}s.list() };
  }

  /**
   * Creates a ${names.kebab} record.
   *
   * @param body - The parsed request body
   * @returns The created record, serialized as JSON
   */
  @Post('/')
  create(@Body() body: Record<string, unknown>): { readonly created: Record<string, unknown> } {
    return { created: body };
  }
}
`;
}

/**
 * Renders the module's service test.
 *
 * A controller test is deliberately not emitted: asserting one would need a
 * booted application or a hand-built `IRequestContext`, and a generated test
 * that asserts nothing is worse than no test at all.
 *
 * @param names - The module's derived naming forms
 * @returns The file contents
 */
function renderServiceTest(names: DerivedNames): string {
  return `import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ${names.pascal}Service } from './${names.kebab}.service.ts';

describe('${names.pascal}Service', () => {
  it('starts with no records', () => {
    const service = new ${names.pascal}Service();

    expect(service.list()).toEqual([]);
  });
});
`;
}

/**
 * Renders the per-module barrel.
 *
 * @param names - The module's derived naming forms
 * @returns The file contents
 */
function renderModuleIndex(names: DerivedNames): string {
  return `/**
 * The ${names.kebab} module's public surface.
 *
 * @module
 */

export { ${names.pascal}Controller } from './${names.kebab}.controller.ts';
export { ${names.pascal}Service } from './${names.kebab}.service.ts';
`;
}

/**
 * Generates a domain module: controller, service, service test, per-module
 * barrel, and the regenerated aggregate barrel that wires it in.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Runtime target, detected plugins, the clock, and the modules
 *   already present in the project
 * @returns Five files under `src/modules/`, of which only the aggregate barrel
 *   is `managed`
 */
export function generateModule(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const dir = `${MODULES_DIR}/${names.kebab}`;

  return [
    { path: `${dir}/${names.kebab}.service.ts`, contents: renderService(names) },
    { path: `${dir}/${names.kebab}.controller.ts`, contents: renderController(names) },
    { path: `${dir}/${names.kebab}.service.test.ts`, contents: renderServiceTest(names) },
    { path: `${dir}/index.ts`, contents: renderModuleIndex(names) },
    {
      path: `${MODULES_DIR}/index.ts`,
      // Union rather than append: regenerating over an existing module must list
      // it exactly once, so `setu g module user` twice is idempotent in the
      // barrel even though it refuses on the module's own files.
      //
      // `?? []` covers a caller that predates the `modules` option — it is
      // optional on the published interface, so an older harness may omit it.
      contents: renderModuleBarrel([...(options.modules ?? []), names.kebab]),
      managed: true,
    },
  ];
}
