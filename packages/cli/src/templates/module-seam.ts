/**
 * The domain-module barrel seam shared by the templates that can host modules.
 *
 * A scaffolded project imports the two barrel arrays into `setu.config.ts` and
 * hands them to `DecoratorPlugin`, so `setu generate module` wires a module in by
 * regenerating one CLI-owned file and never editing the developer's config.
 *
 * Emitted from scaffold time, deliberately: a project that gains the seam only
 * once its first module is generated would need `setu.config.ts` edited at that
 * moment, which is the write this whole design exists to avoid.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { MODULES_DIR } from '../utils/module-scanner.ts';
import {
  CONTROLLERS_EXPORT,
  renderModuleBarrel,
  SERVICES_EXPORT,
} from '../schematics/module-barrel.ts';
import type { LocalImport, TemplateManifest, Wiring } from './registry.ts';

/** Specifier the generated `setu.config.ts` imports the barrel from. */
const BARREL_SPECIFIER = `./${MODULES_DIR}/index.ts`;

/**
 * Test dependencies the module schematic's emitted `*.service.test.ts` imports.
 *
 * A host template MUST declare these, or the first `deno test` a developer runs
 * fails with `Import "@std/testing/bdd" not a dependency and not in import map` —
 * the CLI would have generated a test file that cannot run.
 *
 * Both forms are needed because the two target families resolve differently:
 * `deno.json` `imports` for Deno and Cloudflare Workers, and npm aliases for Node
 * and Bun, which get a `package.json` and no `deno.json` at all. The alias form
 * matches how those targets already reach `@setu-ts/*`.
 */
const TEST_DEPENDENCY_VERSIONS = {
  '@std/testing': '1.0.19',
  '@std/expect': '1.0.20',
} as const;

/**
 * Manifest additions every functional module-hosting template merges in.
 *
 * Functional and class-based module tests both import the standard test
 * packages. The health permission belongs to the REST baseline, while the
 * decorator compiler setting is restricted to the class-based opt-in below.
 */
export const FUNCTIONAL_MODULE_MANIFEST: TemplateManifest = {
  denoImports: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map(([pkg, v]) => [pkg, `jsr:${pkg}@^${v}`]),
  ),
  npmDevDependencies: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map((
      [pkg, v],
    ) => [pkg, `npm:@jsr/${pkg.slice(1).replace('/', '__')}@^${v}`]),
  ),
  // `HealthPlugin`'s `self` indicator reads `runtime.hostname()` on every probe.
  // Without this the project scaffolds, starts, and answers 500 on `/health` —
  // the path the generated Kubernetes probes point at.
  denoPermissions: ['--allow-sys'],
};

/** Manifest additions unique to the class-based module composition. */
export const CLASS_BASED_MODULE_MANIFEST: TemplateManifest = {
  ...FUNCTIONAL_MODULE_MANIFEST,
  // The class-based template emits decorated classes.
  denoCompilerOptions: { experimentalDecorators: true },
};

/**
 * The empty aggregate barrel a fresh project starts with.
 *
 * Rendered by the same function `setu generate module` uses, so the scaffolded
 * file and every regeneration of it can never drift apart in shape.
 */
export const MODULE_SEAM_FILES: readonly GeneratedFile[] = [
  { path: `${MODULES_DIR}/index.ts`, contents: renderModuleBarrel([]) },
];

/** The `setu.config.ts` import that brings both barrel arrays into scope. */
export const MODULE_SEAM_LOCAL_IMPORT: LocalImport = {
  symbols: [CONTROLLERS_EXPORT, SERVICES_EXPORT],
  from: BARREL_SPECIFIER,
};

/**
 * Rewrites a wiring list so the `decorator-plugin` entry passes the barrel
 * arrays.
 *
 * Takes the list rather than mutating a shared constant so the class-based
 * template can apply it to its own set without changing the REST baseline.
 *
 * @param wirings - The template's plugin wirings
 * @param extraControllers - Identifiers listed before the barrel spread
 * @param extraServices - Identifiers listed before the barrel spread
 * @returns The list with the decorator wiring's `args` replaced
 */
export function withModuleSeam(
  wirings: readonly Wiring[],
  extraControllers: readonly string[] = [],
  extraServices: readonly string[] = [],
): readonly Wiring[] {
  const controllers = [...extraControllers, `...${CONTROLLERS_EXPORT}`].join(', ');
  const services = [...extraServices, `...${SERVICES_EXPORT}`].join(', ');

  return wirings.map((wiring) =>
    wiring.pkg === 'decorator-plugin'
      ? { ...wiring, args: renderDecoratorArgs(controllers, services) }
      : wiring
  );
}

/**
 * Renders the decorator wiring's argument object, breaking onto lines when the
 * single-line form would run long.
 *
 * Wrapping matters because the emitted `setu.config.ts` is a file a developer opens and
 * edits: once the standalone-controller and standalone-service barrels join the module
 * ones, the inline form runs past 110 characters inside the plugin array.
 *
 * The indentation is absolute rather than relative — `Wiring.args` is rendered verbatim
 * into an array entry the renderer has already indented by six spaces, so a
 * continuation line has to carry its own eight and the closing brace its own six.
 *
 * @param controllers - Rendered contents of the `controllers` array
 * @param services - Rendered contents of the `services` array
 * @returns The argument source, without the enclosing parentheses
 */
function renderDecoratorArgs(controllers: string, services: string): string {
  const inline = `{ controllers: [${controllers}], services: [${services}] }`;
  // 6 spaces of array indent + `DecoratorPlugin(` + `),` is 24 characters of overhead.
  if (inline.length <= 76) return inline;
  return `{\n        controllers: [${controllers}],\n        services: [${services}],\n      }`;
}
