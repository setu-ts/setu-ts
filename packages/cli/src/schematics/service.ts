/**
 * Service schematic — a domain service class.
 *
 * The one schematic whose emitted shape depends on the target project. A bare class
 * has no framework registration site; it acquires one only when `decorator-plugin` is
 * installed, because then it can be an `@Injectable` whose token resolves from the
 * service registry (or the DI container, when one exists).
 *
 * So the decorator and the seam barrel are emitted only when that plugin is detected.
 * Emitting them unconditionally would force this schematic to be gated like
 * `controller` — its own import could not otherwise resolve — which would REFUSE
 * `setu g service` in a bare project, where it works today.
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { APP_SERVICES_EXPORT, SERVICES_SEAM, serviceSeamToken } from '../seams/services.ts';
import { seamNames } from '../seams/seam-spec.ts';

/** The `@setu-ts` package whose presence turns the service into an `@Injectable`. */
const DECORATOR_PLUGIN = 'decorator-plugin';

/**
 * Renders the plain, framework-free class.
 *
 * @param names - Naming forms derived from the user's input
 * @returns The file contents
 */
function renderPlainService(names: DerivedNames): string {
  return `/**
 * ${names.pascal} domain service.
 *
 * No framework registration: this class has no decorator and no capability token, so
 * it is used by whatever imports it. Install \`@setu-ts/decorator-plugin\` and
 * regenerate to get an \`@Injectable\` registered under \`${serviceSeamToken(names.kebab)}\`.
 */
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
 * constructor parameter, or \`services.get('${serviceSeamToken(names.kebab)}')\`.
 *
 * It works with and without \`DiPlugin\`: with a container the service is constructed
 * through it, and without one it lands in the kernel's service registry.
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
  const injectable = options.plugins.has(DECORATOR_PLUGIN);
  const service: GeneratedFile = {
    path: `src/services/${names.kebab}.service.ts`,
    contents: injectable ? renderInjectableService(names) : renderPlainService(names),
  };

  if (!injectable) return [service];

  return [
    service,
    {
      path: SERVICES_SEAM.barrel,
      contents: SERVICES_SEAM.renderBarrel({
        service: seamNames(options.artifacts, 'service', names.kebab),
      }),
      managed: true,
    },
  ];
}
