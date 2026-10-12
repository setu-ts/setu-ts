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

import { type FrameworkManifest, frameworkSpecifier } from '../templates/framework-specifier.ts';
import { parseJsonc } from '../utils/manifest-reader.ts';

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
  /** Why the manifest could not be read, when it could not; nothing is rewritten then. */
  readonly unreadable?: string;
}

/** The JSON string literal for `value`, as it appears in manifest text. */
function literal(value: string): string {
  return JSON.stringify(value);
}

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    parsed = parseJsonc(source);
  } catch (cause) {
    return {
      contents: undefined,
      rewrites: [],
      unreadable: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { contents: undefined, rewrites: [], unreadable: 'the manifest is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const rewrites: PinRewrite[] = [];
  for (const section of SECTIONS[manifest]) {
    const entries = record[section];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue;
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const pkg = legacyFrameworkPackage(value);
      if (pkg === undefined || name !== `@setu-ts/${pkg}`) continue;
      rewrites.push({ name, from: value, to: frameworkSpecifier(pkg, manifest) });
    }
  }
  if (rewrites.length === 0) return { contents: undefined, rewrites };
  // Edited in place rather than re-serialised, so a JSONC manifest keeps its
  // comments, ordering and layout: only each `"name": "value"` pair changes.
  let contents = source;
  for (const { name, from, to } of rewrites) {
    const pair = new RegExp(
      `(${escapeRegExp(literal(name))}\\s*:\\s*)${escapeRegExp(literal(from))}`,
    );
    contents = contents.replace(pair, (_match, head: string) => `${head}${literal(to)}`);
  }
  return { contents, rewrites };
}
