/**
 * The test dependencies every host must declare, because every host can now
 * generate a test.
 *
 * `setu generate module` emits a `*.service.test.ts` beside the service it
 * writes. M58 made that schematic emit the test; M65 made the schematic
 * UNGATED, so the file is reachable from every project shape rather than only
 * from the decorator-installing templates that happened to declare these two
 * packages. A host that omits them ships a project where the very first
 * `deno test` a developer runs fails with
 * `Import "@std/testing/bdd" not a dependency and not in import map` — the CLI
 * generated a test file that cannot run.
 *
 * Owned here rather than beside the module barrel, because the barrel is a
 * class-based concern while this is a property of every host.
 *
 * @module
 */

import type { TemplateManifest } from './registry.ts';

/** Versions the emitted test imports, pinned once for both dependency forms. */
const TEST_DEPENDENCY_VERSIONS = {
  '@std/testing': '1.0.19',
  '@std/expect': '1.0.20',
} as const;

/**
 * Manifest additions that make the module schematic's emitted test runnable.
 *
 * Both forms are needed because the two target families resolve differently:
 * `deno.json` `imports` for Deno and Cloudflare Workers, and npm aliases for
 * Node and Bun, which get a `package.json` and no `deno.json` at all. The alias
 * form matches how those targets already reach `@setu-ts/*`.
 *
 * Declaring `npmDevDependencies` does NOT give a Deno project a `package.json`:
 * {@linkcode TemplateManifest.npmBuildScript} is what marks a template with a
 * real frontend npm toolchain, precisely so a non-frontend template can declare
 * a dev dependency without switching Deno to node_modules resolution.
 */
export const TEST_DEPENDENCY_MANIFEST: TemplateManifest = {
  denoImports: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map(([pkg, v]) => [pkg, `jsr:${pkg}@^${v}`]),
  ),
  npmDevDependencies: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map((
      [pkg, v],
    ) => [pkg, `npm:@jsr/${pkg.slice(1).replace('/', '__')}@^${v}`]),
  ),
};
