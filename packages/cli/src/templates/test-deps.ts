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
 * **Deno targets only.** Node and Bun deliberately declare neither, because
 * neither can use them: `@std/testing/bdd` reaches `Deno.test` inside its own
 * `_test_suite.js`, so a generated test importing it dies with
 * `ReferenceError: Deno is not defined` before any assertion runs — established
 * by running it on Bun, not by reading it. Those targets emit `bun:test` and
 * `node:test` instead, which are built in and need no dependency at all
 * (`schematics/test-harness.ts`). Declaring the npm aliases here shipped two
 * packages that could only fail.
 *
 * Declaring `npmDevDependencies` does NOT give a Deno project a `package.json`:
 * {@linkcode TemplateManifest.npmBuild} is what marks a template with a
 * real frontend npm toolchain, precisely so a non-frontend template can declare
 * a dev dependency without switching Deno to node_modules resolution.
 */
export const TEST_DEPENDENCY_MANIFEST: TemplateManifest = {
  denoImports: Object.fromEntries(
    Object.entries(TEST_DEPENDENCY_VERSIONS).map(([pkg, v]) => [pkg, `jsr:${pkg}@^${v}`]),
  ),
};
