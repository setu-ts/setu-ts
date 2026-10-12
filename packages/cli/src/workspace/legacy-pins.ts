/**
 * Moves a pre-0.9 project's framework pins onto the npm packages.
 *
 * Before 0.9 the CLI pinned `jsr:@setu-ts/<pkg>` in a Deno import map and the
 * JSR npm-compatibility alias `npm:@jsr/setu-ts__<pkg>` in a `package.json`,
 * routed through an `.npmrc`. From 0.9 the framework is published to npm under
 * its own names. `setu adopt` brings such a project into a workspace whose root
 * carries no registry mapping, so it rewrites those pins — and only those — to
 * the npm form this CLI writes, reporting each one. A project's `.npmrc` is left
 * where adoption moved it: a registry setting is the developer's.
 *
 * @module
 */

import { frameworkSpecifier, type FrameworkManifest } from '../templates/framework-specifier.ts';

/** One pin moved onto npm. */
export interface PinRewrite {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/** The rewritten manifest, or `undefined` when nothing needed rewriting. */
export interface LegacyPinResult {
  readonly contents: string | undefined;
  readonly rewrites: readonly PinRewrite[];
}

/** The sections of each manifest kind that can hold a framework pin. */
const SECTIONS: Readonly<Record<FrameworkManifest, readonly string[]>> = {
  deno: ['imports'],
  npm: ['dependencies', 'devDependencies'],
};

/**
 * The package a pre-0.9 pin names, or `undefined` for any other value.
 *
 * @param value - A manifest entry's value
 * @returns The unscoped framework package name
 */
export function legacyFrameworkPackage(value: string): string | undefined {
  return /^npm:@jsr\/setu-ts__([a-z0-9-]+)@/.exec(value)?.[1] ??
    /^jsr:\/?@setu-ts\/([a-z0-9-]+)@/.exec(value)?.[1];
}

/**
 * Rewrites every pre-0.9 framework pin in one manifest.
 *
 * Only an entry whose KEY is the same framework package its value names is
 * touched, so a hand-written alias pointing one name at another package is the
 * developer's and stays as written.
 *
 * @param source - The manifest text
 * @param manifest - `deno` for `deno.json`, `npm` for `package.json`
 * @returns The new text and every rewrite, or `undefined` contents when none
 */
export function rewriteLegacyPins(source: string, manifest: FrameworkManifest): LegacyPinResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { contents: undefined, rewrites: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { contents: undefined, rewrites: [] };
  }
  const record = parsed as Record<string, unknown>;
  const rewrites: PinRewrite[] = [];
  for (const section of SECTIONS[manifest]) {
    const entries = record[section];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue;
    const table = entries as Record<string, unknown>;
    for (const [name, value] of Object.entries(table)) {
      if (typeof value !== 'string') continue;
      const pkg = legacyFrameworkPackage(value);
      if (pkg === undefined || name !== `@setu-ts/${pkg}`) continue;
      const to = frameworkSpecifier(pkg, manifest);
      table[name] = to;
      rewrites.push({ name, from: value, to });
    }
  }
  return rewrites.length === 0
    ? { contents: undefined, rewrites }
    : { contents: `${JSON.stringify(record, null, 2)}\n`, rewrites };
}
