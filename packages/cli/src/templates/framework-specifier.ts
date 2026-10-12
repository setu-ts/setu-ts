/**
 * The one place a generated project's framework pin is spelled.
 *
 * Every emitter — `setu new`, `setu add`, `setu devtool enable` — asks here, so
 * the specifiers cannot drift apart. A project is pinned to the CLI's OWN
 * version, because a CLI scaffolds against the framework it was released with.
 * Every target takes the framework from npm under its real name: a Deno import
 * map through an `npm:` specifier, every `package.json` through a plain range.
 *
 * @module
 */

import { VERSION } from '../version.ts';

/** The range every framework pin carries: the CLI's own version, caret-ranged. */
export const FRAMEWORK_RANGE: string = `^${VERSION}`;

/** Which manifest a pin is written into. */
export type FrameworkManifest = 'deno' | 'npm';

/**
 * The specifier a manifest pins one framework package at.
 *
 * @param pkg - The package's name without the scope (`kernel`)
 * @param manifest - `deno` for an import map, `npm` for a `package.json`
 * @returns `npm:@setu-ts/<pkg>@^V` for Deno, `^V` for npm
 */
export function frameworkSpecifier(pkg: string, manifest: FrameworkManifest): string {
  return manifest === 'deno' ? `npm:@setu-ts/${pkg}@${FRAMEWORK_RANGE}` : FRAMEWORK_RANGE;
}
