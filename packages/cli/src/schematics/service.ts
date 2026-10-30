/**
 * Service schematic — a domain service, as a function or as an injectable class.
 *
 * The one schematic whose emitted shape depends on the target project. A plain function
 * has no framework registration site; the artifact acquires one only when
 * `decorator-plugin` is installed, because then it can be an `@Injectable` whose token
 * resolves from the service registry (or the DI container, when one exists).
 *
 * So the DECORATOR is emitted only when that plugin is detected. Emitting it
 * unconditionally would force this schematic to be gated like `controller` — its own
 * import could not otherwise resolve — which would REFUSE `setu g service` in a bare
 * project, where it works today.
 *
 * Both modes emit a barrel, and the difference matters: the class one is the
 * registration `setu.config.ts` passes to `DecoratorPlugin` — inline as
 * `DecoratorPlugin({ services: [...APP_SERVICES] })`, or through a starter's
 * `decorators: { services: … }` arm — while the functional one is a convenience
 * re-export nothing imports for you. `setu generate` reports when the class
 * barrel is written but `setu.config.ts` references neither form, so the barrel
 * alone is never claimed to be wired.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import {
  APP_SERVICES_EXPORT,
  FUNCTIONAL_SERVICES_SEAM,
  functionalServiceSymbol,
  SERVICES_SEAM,
  serviceSeamToken,
} from '../seams/services.ts';
import { seamNames } from '../seams/seam-spec.ts';
import { generatorMode } from '../utils/generator-mode.ts';

/**
 * Renders the plain, framework-free class.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The file contents
 */
function renderFunctionalService(names: DerivedNames, module?: string): string {
  return `/**
 * ${names.pascal} domain service.
 *
 * This is a plain function: import it where it is needed, or close over it from a
 * route-registration function. The functional application style uses the request
 * context as its explicit capability injector rather than constructor injection.
 *
 * Nothing registers this for you — a plain function has no framework registration
 * site. ${module === undefined ? '`src/services/index.ts` re-exports it as a convenience.' : `Import it from './${names.kebab}.service.ts' in a sibling route.`}
 *
 * @returns A placeholder value
 */
export function ${functionalServiceSymbol(names)}(): string {
  return '${names.kebab}';
}
`;
}

/**
 * Renders the injectable class.
 *
 * The token is explicit rather than inferred from the class name, matching the module
 * schematic: `emitDecoratorMetadata` is unavailable under Deno, so a consumer's
 * `@Inject` cannot read a parameter's type and must name the token as a string.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The file contents
 */
function renderInjectableService(names: DerivedNames, module?: string): string {
  if (module !== undefined) {
    return `import { Injectable } from '@setu-ts/decorator-plugin';

/** Add this provider to ${module}.module.ts and inject '${serviceSeamToken(`${module}.${names.kebab}`)}'. */
@Injectable({ token: '${serviceSeamToken(`${module}.${names.kebab}`)}' })
export class ${names.pascal}Service {
  /** Replace with the service's real behavior. */
  describe(): string {
    return '${names.kebab}';
  }
}
`;
  }
  return `import { Injectable } from '@setu-ts/decorator-plugin';

/**
 * ${names.pascal} domain service.
 *
 * Registered through the \`${APP_SERVICES_EXPORT}\` barrel in \`src/services/index.ts\`:
 * \`setu.config.ts\` passes it as
 * \`DecoratorPlugin({ services: [...${APP_SERVICES_EXPORT}] })\`, or a starter does
 * through its \`decorators: { services: … }\` arm. \`setu generate\` reports when the
 * config references neither, so this class is never claimed wired without it.
 * Consumers reach it by listing \`'${serviceSeamToken(names.kebab)}'\` in their
 * class-level \`@Inject(...)\`, one token per constructor argument in order, which
 * works whether or not a container is registered.
 *
 * Resolving it BY HAND depends on the composition, because the two paths register
 * in different places:
 *
 * - without \`DiPlugin\`: the class is instantiated once and stored in the kernel's
 *   registry — \`services.get('${serviceSeamToken(names.kebab)}')\`. \`scope\` is ignored,
 *   because there is one instance.
 * - with \`DiPlugin\` (the \`--template class-based\` composition): the class is registered
 *   as a PROVIDER on the container and is NOT in the kernel registry, so
 *   \`services.get(...)\` throws. Resolve through the container —
 *   \`services.get<IContainer>(CAPABILITIES.DI_CONTAINER).resolve('${serviceSeamToken(
   names.kebab,
 )}')\` — and \`scope\` is honored.
 */
@Injectable({ token: '${serviceSeamToken(names.kebab)}' })
export class ${names.pascal}Service {
  /**
   * Replace with the service's real behavior.
   *
   * @returns A placeholder value
   */
  describe(): string {
    return '${names.kebab}';
  }
}
`;
}

/**
 * Generates a service class, and its seam barrel when the project can consume one.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Read for the detected plugin set and the services already present
 * @returns The service at `src/services/<kebab>.service.ts`, plus the managed
 *   `src/services/index.ts` barrel when `decorator-plugin` is installed
 */
export function generateService(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const classBased = generatorMode(options.plugins) === 'class-based';
  const service: GeneratedFile = {
    path: `${options.targetModule === undefined ? 'src/services' : `src/modules/${options.targetModule}`}/${names.kebab}.service.ts`,
    contents: classBased
      ? renderInjectableService(names, options.targetModule)
      : renderFunctionalService(names, options.targetModule),
  };
  if (options.targetModule !== undefined) return [service];

  // Both modes emit the barrel, but they are not the same barrel. The class one is a
  // REGISTRATION for `DecoratorPlugin({ services })` or a starter's `decorators` arm —
  // and `setu generate` reports when the config references it from neither. The
  // functional one is a convenience re-export that nothing imports for you — there is
  // no plugin option taking a list of functions.
  const spec = classBased ? SERVICES_SEAM : FUNCTIONAL_SERVICES_SEAM;

  return [
    service,
    {
      path: spec.barrel,
      contents: spec.renderBarrel({
        service: seamNames(options.artifacts, 'service', names.kebab),
      }),
      managed: true,
    },
  ];
}
