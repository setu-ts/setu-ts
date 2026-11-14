/**
 * The one place a generated project's framework version specifiers are spelled.
 *
 * Every emitter — `setu new`, `setu add`, `setu devtool enable` — asks here, so
 * the specifiers cannot drift apart. Manifest ranges start at the CLI's own
 * version, because it scaffolds against the framework it was released with.
 * Commands needing that exact release use `exactFrameworkSpecifier` instead.
 * Every target takes the framework from npm under its real name: a Deno import
 * map through an `npm:` specifier, every `package.json` through a plain range.
 *
 * @module
 */

import { VERSION } from '../version.ts';

/** The range every framework pin carries: the CLI's own version, caret-ranged. */
export const FRAMEWORK_RANGE: string = `^${VERSION}`;

/** Returns the exact Deno executable specifier for this CLI release. */
export function exactFrameworkSpecifier(pkg: string): string {
  return `npm:@setu-ts/${pkg}@${VERSION}`;
}

/** Which manifest a pin is written into. */
export type FrameworkManifest = 'deno' | 'npm';

/**
 * The compatible range a manifest uses for one framework package.
 *
 * @param pkg - The package's name without the scope (`kernel`)
 * @param manifest - `deno` for an import map, `npm` for a `package.json`
 * @returns `npm:@setu-ts/<pkg>@^V` for Deno, `^V` for npm
 */
export function frameworkSpecifier(pkg: string, manifest: FrameworkManifest): string {
  return manifest === 'deno' ? `npm:@setu-ts/${pkg}@${FRAMEWORK_RANGE}` : FRAMEWORK_RANGE;
}
