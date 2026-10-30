/**
 * The package version.
 *
 * A literal rather than the former `deno.json` JSON import (M111a plan
 * §3.5): the JSON import left `rootDir`, and `deno.json` does not ship in an
 * npm tarball. `release:bump` rewrites this file, `deno.json` and
 * `package.json` together, so the three cannot drift;
 * `test/version-constant.test.ts` is the guard.
 *
 * @module
 */

export const VERSION: string = '0.11.0';
