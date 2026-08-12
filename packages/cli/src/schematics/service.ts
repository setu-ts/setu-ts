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
 * registration `setu.config.ts` passes to `DecoratorPlugin`, while the functional one
 * is a convenience re-export nothing imports for you. The functional barrel is also
 * what makes the scan admit these files — see `seams/services.ts`.
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
function renderFunctionalService(names: DerivedNames): string {
  return `/**
 * ${names.pascal} domain service.
 *
 * This is a plain function: import it where it is needed, or close over it from a
 * route-registration function. The functional application style uses the request
 * context as its explicit capability injector rather than constructor injection.
 *
 * Nothing registers this for you — a plain function has no framework registration
 * site. \`src/services/index.ts\` re-exports it as a convenience, so a consumer can
 * import from one path rather than from each module.
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
function renderInjectableService(names: DerivedNames): string {
  return `import { Injectable } from '@setu-ts/decorator-plugin';

/**
 * ${names.pascal} domain service.
 *
 * Registered through the \`${APP_SERVICES_EXPORT}\` barrel in \`src/services/index.ts\`,
 * which \`setu.config.ts\` passes to \`DecoratorPlugin\` — so this class needs no further
 * wiring. Consumers reach it with \`@Inject('${serviceSeamToken(names.kebab)}')\` on a
 * constructor parameter, which works whether or not a container is registered.
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
 *   \`services.get<IContainer>(CAPABILITIES.DI_CONTAINER).resolve('${
    serviceSeamToken(names.kebab)
  }')\` — and \`scope\` is honored.
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
    path: `src/services/${names.kebab}.service.ts`,
    contents: classBased ? renderInjectableService(names) : renderFunctionalService(names),
  };

  // Both modes emit the barrel, but they are not the same barrel. The class one is a
  // REGISTRATION: `setu.config.ts` imports `APP_SERVICES` and hands it to
  // `DecoratorPlugin`. The functional one is a convenience re-export that nothing
  // imports for you — there is no plugin option taking a list of functions.
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
