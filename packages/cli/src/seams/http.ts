/**
 * The HTTP seam — one directory for everything that answers a request.
 *
 * Before M70h a project had TWO directories producing HTTP endpoints,
 * `src/routes/` and `src/controllers/`, wired by mechanisms that never
 * referenced each other: `registerGeneratedRoutes(app.router)` and
 * `DecoratorPlugin({ controllers })`. The naming borrowed from two precedents
 * whose relationships are different from that one — in ASP.NET and NestJS a
 * controller IS the routing layer, and in Rails and Laravel a routes file MAPS
 * to controllers — so neither reading predicted what this framework did.
 *
 * The split also created a collision surface that had to be mitigated rather
 * than removed: generating a route and a controller under one name claims the
 * same HTTP path, and M60 added a refusal for it. And a hand-written module in
 * `src/routes/` was silently adopted into the CLI-owned barrel, which since
 * M68's duplicate-route refusal stops the application booting (F2/X4-4).
 *
 * So there is now ONE directory, `src/controllers`, and ONE barrel that carries
 * both exports. This is not a new mechanism: it is exactly the pattern
 * `seams/services.ts` already ships, where two `SeamSpec`s share a directory and
 * a barrel and are selected by generator mode. {@linkcode SeamSpec.renderBarrel}
 * takes the full {@linkcode SeamArtifacts} record rather than one name list
 * precisely "so a shared barrel can read both of its kinds".
 *
 * Three kinds share it:
 *
 * | Spec                          | Suffix           | Mode        | Emits                        |
 * | ----------------------------- | ---------------- | ----------- | ---------------------------- |
 * | {@linkcode CONTROLLERS_SEAM}  | `.controller.ts` | class-based | an `@Controller` class       |
 * | {@linkcode FUNCTIONAL_CONTROLLERS_SEAM} | `.controller.ts` | functional | `registerXRoutes(router)` |
 * | {@linkcode ROUTES_SEAM}       | `.routes.ts`     | both        | the imperative escape hatch  |
 *
 * `.routes.ts` survives in BOTH modes and is not redundant: `@Controller` has no
 * wildcard decorator and cannot compute routes in a loop, so a proxy registering
 * five methods across `/api/auth/*` patterns from a data table can only be a
 * route module. The suffix names that at the filename level, which is the right
 * altitude — it needed a distinguishing name, never its own directory.
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderExportedArray,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
import type { DerivedNames } from '../utils/names.ts';
import { deriveNames } from '../utils/names.ts';
import type { GeneratorMode } from '../utils/generator-mode.ts';

/** Barrel export naming every generated `@Controller` class. */
export const APP_CONTROLLERS_EXPORT = 'APP_CONTROLLERS';

/** Barrel export that registers every generated route-shaped module. */
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

/**
 * The symbol a route-shaped module exports — a functional controller as well as
 * a `.routes.ts` escape hatch, because both register imperatively on a router.
 *
 * Owned here rather than in the schematics, for the reason
 * {@linkcode SeamSpec.importSymbols} gives: the renderer that names a symbol and
 * the scanner that admits a file by it must read ONE definition. M60 shipped a
 * defect precisely because those two had drifted.
 *
 * @param names - The artifact's derived naming forms
 * @returns The exported function's name
 */
export function routeRegistrarSymbol(names: DerivedNames): string {
  return `register${names.pascal}Routes`;
}

/**
 * Renders `src/controllers/index.ts` for a generator mode.
 *
 * Reads BOTH artifact kinds, which is the whole point of the merge: whichever
 * schematic triggered the regeneration, the barrel it writes carries every
 * module in the directory.
 *
 * @param mode - The project's generator mode, which decides the controller shape
 * @returns A barrel renderer for that mode
 */
function renderHttpBarrel(mode: GeneratorMode): (artifacts: SeamArtifacts) => string {
  return (artifacts: SeamArtifacts): string => {
    const controllers = seamNames(artifacts, 'controller');
    const routes = seamNames(artifacts, 'route');
    const classBased = mode === 'class-based';

    // In functional mode a `.controller.ts` registers imperatively, exactly like
    // a `.routes.ts` — so both feed the registrar and the class array is absent.
    const registrars = [
      ...(classBased ? [] : controllers.map((name) => ({ name, suffix: '.controller.ts' }))),
      ...routes.map((name) => ({ name, suffix: '.routes.ts' })),
    ];

    const wiring = [
      ...(classBased && controllers.length > 0
        ? [`DecoratorPlugin({ controllers: [...${APP_CONTROLLERS_EXPORT}] })`]
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
      ...registrars.map((entry) =>
        renderSeamImports(
          [entry.name],
          (names) => [routeRegistrarSymbol(names)],
          (kebab) => `./${kebab}${entry.suffix}`,
        )
      ),
    ].filter((line) => line !== '').join('\n\n');

    const calls = registrars.length === 0
      // An empty body still has to USE the parameter, or the generated project
      // fails `noUnusedParameters` — which the drift gate applies, since it
      // merges this workspace's compiler options into every project it checks.
      ? '  void router;\n  void services;'
      : `  for (const register of GENERATED_ROUTE_REGISTRARS) {\n` +
        `    register(router, services);\n` +
        `  }`;

    const declarations = [
      ...(registrars.length > 0
        ? [
          `/** A generated registrar may predate the service-registry parameter. */\n` +
          `type GeneratedRouteRegistrar = (router: IRouterApi, services?: IServiceRegistry) => void;\n\n` +
          `const GENERATED_ROUTE_REGISTRARS: readonly GeneratedRouteRegistrar[] = [\n` +
          registrars.map((entry) => `  ${routeRegistrarSymbol(deriveNames(entry.name))},`).join(
            '\n',
          ) +
          `\n];`,
        ]
        : []),
      ...(classBased
        ? [
          `/** Every generated controller class, for \`DecoratorPlugin({ controllers })\`. */\n` +
          renderExportedArray(
            APP_CONTROLLERS_EXPORT,
            'Constructor',
            controllers.map((name) => controllerClassSymbol(deriveNames(name))),
          ),
        ]
        : []),
      `/**\n` +
      ` * Registers every generated route-shaped module.\n` +
      ` *\n` +
      ` * @param router - The router to register on, normally \`app.router\`\n` +
      ` * @param services - The service registry, normally \`app.services\`\n` +
      ` */\n` +
      `export function ${REGISTER_ROUTES_EXPORT}(router: IRouterApi, services: IServiceRegistry): void {\n` +
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

/** The imperative escape hatch, in a class-based project. */
export const ROUTES_SEAM: SeamSpec = {
  schematic: 'route',
  dir: HTTP_SEAM_DIR,
  suffix: '.routes.ts',
  importSymbols: (names) => [routeRegistrarSymbol(names)],
  barrel: HTTP_SEAM_BARREL,
  exports: [APP_CONTROLLERS_EXPORT, REGISTER_ROUTES_EXPORT],
  renderBarrel: renderHttpBarrel('class-based'),
};

/** The imperative escape hatch, in a functional project. */
export const FUNCTIONAL_ROUTES_SEAM: SeamSpec = {
  schematic: 'route',
  dir: HTTP_SEAM_DIR,
  suffix: '.routes.ts',
  importSymbols: (names) => [routeRegistrarSymbol(names)],
  barrel: HTTP_SEAM_BARREL,
  exports: [REGISTER_ROUTES_EXPORT],
  renderBarrel: renderHttpBarrel('functional'),
};
