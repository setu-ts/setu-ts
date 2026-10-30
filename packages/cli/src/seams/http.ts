/**
 * One controller family, one `.controller.ts` suffix, two export shapes.
 *
 * A class controller exports a decorated `<Pascal>Controller`. A function
 * controller exports `register<Pascal>Routes(router, services)` and can express
 * wildcards, proxies and route tables computed in a loop. `g controller` chooses
 * the project default; `g route` always writes a function controller.
 *
 * @module
 */
import { artifactNames } from '../utils/artifact-path.ts';

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderExportedArray,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
import type { DerivedNames } from '../utils/names.ts';
import type { GeneratorMode } from '../utils/generator-mode.ts';

/** Barrel export naming every generated `@Controller` class. */
export const APP_CONTROLLERS_EXPORT = 'APP_CONTROLLERS';

/** Barrel export that registers every generated function controller. */
export const REGISTER_ROUTES_EXPORT = 'registerGeneratedRoutes';

/** The one directory everything answering HTTP is generated into. */
export const HTTP_SEAM_DIR = 'src/controllers';

/** The one barrel both kinds are registered through. */
export const HTTP_SEAM_BARREL = 'src/controllers/index.ts';

/**
 * The symbol a class-shaped controller module exports.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported class name
 */
export function controllerClassSymbol(names: DerivedNames): string {
  return `${names.pascal}Controller`;
}

/** The export a function controller provides. */
export function routeRegistrarSymbol(names: DerivedNames): string {
  return `register${names.pascal}Routes`;
}

/** Function-controller paths within the single controller family. */
export const FUNCTION_CONTROLLER_ARTIFACTS: string = 'controller-functions';

/** Splits one admitted controller family by the exports its files provide. */
export function controllerShapes(
  artifacts: SeamArtifacts,
  mode: GeneratorMode,
): { readonly classes: readonly string[]; readonly functions: readonly string[] } {
  const all = seamNames(artifacts, 'controller');
  if (mode === 'functional') return { classes: [], functions: all };
  const functions = seamNames(artifacts, FUNCTION_CONTROLLER_ARTIFACTS);
  return { classes: all.filter((name) => !functions.includes(name)), functions };
}

/** Adds a newly generated controller before its file is visible to the scanner. */
export function withControllerArtifact(
  artifacts: SeamArtifacts | undefined,
  name: string,
  shape: 'class' | 'function',
): SeamArtifacts {
  return {
    ...artifacts,
    controller: seamNames(artifacts, 'controller', name),
    [FUNCTION_CONTROLLER_ARTIFACTS]: seamNames(
      artifacts,
      FUNCTION_CONTROLLER_ARTIFACTS,
      shape === 'function' ? name : undefined,
    ),
  };
}

/**
 * Renders `src/controllers/index.ts` for a generator mode.
 *
 * Every regeneration preserves both class controllers and function controllers,
 * regardless of which shape the current command writes.
 *
 * @param mode - The project's generator mode, which decides the controller shape
 * @returns A barrel renderer for that mode
 */
function renderHttpBarrel(mode: GeneratorMode): (artifacts: SeamArtifacts) => string {
  return (artifacts: SeamArtifacts): string => {
    const { classes: controllers, functions: registrars } = controllerShapes(artifacts, mode);
    const classBased = mode === 'class-based';

    const wiring = [
      ...(classBased
        ? [
            ...(controllers.length > 0
              ? [`DecoratorPlugin({ controllers: [...${APP_CONTROLLERS_EXPORT}] })`]
              : []),
            `a starter's \`decorators: { controllers: [...${APP_CONTROLLERS_EXPORT}] }\` arm`,
          ]
        : []),
      `${REGISTER_ROUTES_EXPORT}(app.router, app.services);`,
    ];
    const header = seamHeader('setu generate controller', wiring);

    const importLines = [
      `import type { ${
        classBased ? 'Constructor, ' : ''
      }IRouterApi, IServiceRegistry } from '@setu-ts/common';`,
      ...(classBased
        ? [
            renderSeamImports(
              controllers,
              (names) => [controllerClassSymbol(names)],
              (kebab) => `./${kebab}.controller.ts`,
            ),
          ]
        : []),
      ...registrars.map((name) =>
        renderSeamImports(
          [name],
          (names) => [routeRegistrarSymbol(names)],
          (kebab) => `./${kebab}.controller.ts`,
        ),
      ),
    ]
      .filter((line) => line !== '')
      .join('\n\n');

    const calls =
      registrars.length === 0
        ? // An empty body still has to USE the parameter, or the generated project
          // fails `noUnusedParameters` — which the drift gate applies, since it
          // merges this workspace's compiler options into every project it checks.
          '  void router;\n  void services;'
        : `  for (const register of GENERATED_ROUTE_REGISTRARS) {\n` +
          `    register(router, services);\n` +
          `  }`;

    const declarations = [
      ...(registrars.length > 0
        ? [
            `/** A generated registrar may predate the service-registry parameter. */\n` +
              `type GeneratedRouteRegistrar = (router: IRouterApi, services?: IServiceRegistry) => void;\n\n` +
              `const GENERATED_ROUTE_REGISTRARS: readonly GeneratedRouteRegistrar[] = [\n` +
              registrars
                .map((name) => `  ${routeRegistrarSymbol(artifactNames(name))},`)
                .join('\n') +
              `\n];`,
          ]
        : []),
      ...(classBased
        ? [
            `/** Every generated controller class, for \`DecoratorPlugin({ controllers })\`. */\n` +
              renderExportedArray(
                APP_CONTROLLERS_EXPORT,
                'Constructor',
                controllers.map((name) => controllerClassSymbol(artifactNames(name))),
              ),
          ]
        : []),
      `/**\n` +
        ` * Registers every generated function controller.\n` +
        ` *\n` +
        ` * @param router - The router to register on, normally \`app.router\`\n` +
        ` * @param services - The service registry, normally \`app.services\`. Optional so a\n *   setu.config.ts written before this parameter existed still compiles.\n` +
        ` */\n` +
        `export function ${REGISTER_ROUTES_EXPORT}(\n` +
        `  router: IRouterApi,\n` +
        `  services?: IServiceRegistry,\n` +
        `): void {\n` +
        `${calls}\n` +
        `}`,
    ];

    return assembleSeamBarrel(header, importLines, declarations);
  };
}

/**
 * The class-shaped controller seam.
 *
 * Gated on `decorator-plugin` no longer — the GATE moved to the shape. A
 * project without the plugin gets {@linkcode FUNCTIONAL_CONTROLLERS_SEAM}
 * instead of a refusal, which is what lets `g controller` work everywhere and
 * what removed M61's refusal-plus-alternative entirely: there is no longer
 * another directory to redirect a developer to.
 */
export const CONTROLLERS_SEAM: SeamSpec = {
  schematic: 'controller',
  dir: HTTP_SEAM_DIR,
  suffix: '.controller.ts',
  importSymbols: (names) => [controllerClassSymbol(names)],
  alternative: {
    artifactsKey: FUNCTION_CONTROLLER_ARTIFACTS,
    importSymbols: (names) => [routeRegistrarSymbol(names)],
  },
  barrel: HTTP_SEAM_BARREL,
  exports: [APP_CONTROLLERS_EXPORT, REGISTER_ROUTES_EXPORT],
  requiresPlugin: 'decorator-plugin',
  renderBarrel: renderHttpBarrel('class-based'),
};

/** The function-shaped controller seam, for a project without decorators. */
export const FUNCTIONAL_CONTROLLERS_SEAM: SeamSpec = {
  schematic: 'controller',
  dir: HTTP_SEAM_DIR,
  suffix: '.controller.ts',
  importSymbols: (names) => [routeRegistrarSymbol(names)],
  barrel: HTTP_SEAM_BARREL,
  exports: [REGISTER_ROUTES_EXPORT],
  renderBarrel: renderHttpBarrel('functional'),
};
