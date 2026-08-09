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

/** Manifest additions every module-hosting template merges in. */
export const MODULE_SEAM_MANIFEST: TemplateManifest = {
  denoImports: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map(([pkg, v]) => [pkg, `jsr:${pkg}@^${v}`]),
  ),
  npmDevDependencies: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map((
      [pkg, v],
    ) => [pkg, `npm:@jsr/${pkg.slice(1).replace('/', '__')}@^${v}`]),
  ),
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
 * Takes the list rather than mutating a shared constant so `rest` and `nest` can
 * each apply it to their own set — the technique `NEST_PLUGINS` already uses to
 * override that same wiring.
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
      ? { ...wiring, args: `{ controllers: [${controllers}], services: [${services}] }` }
      : wiring
  );
}
