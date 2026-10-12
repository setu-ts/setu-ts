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

/** One string value directly inside a pin section, with its exact source span. */
interface SectionEntry {
  readonly section: string;
  readonly name: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** One open object or array while scanning, and where its keys stand. */
interface Frame {
  readonly kind: 'object' | 'array';
  /** The key this container is the value of, in its parent object. */
  readonly key: string | undefined;
  /** Whether the next string in this object is a key (`true`) or a value. */
  expectingKey: boolean;
  lastKey: string | undefined;
}

/**
 * Lists every string value directly inside a top-level pin section, with the
 * exact span of its literal in `source`.
 *
 * A token scan rather than a text search, so the rewrite can only ever touch a
 * real entry: a comment that quotes a pin, the same key in another section
 * (`overrides`), or a value spelled with JSON escapes (`jsr:\/@setu-ts\/…`) is
 * each seen for what it is (M111d audit F4). Comments are skipped; strings are
 * decoded exactly as `JSON.parse` decodes them.
 *
 * @param source - Manifest text already known to parse as JSONC
 * @param sections - The top-level keys whose entries are wanted
 * @returns Every string entry of those sections, in source order
 */
function sectionEntries(source: string, sections: readonly string[]): SectionEntry[] {
  const entries: SectionEntry[] = [];
  const stack: Frame[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    const top = stack[stack.length - 1];
    if (char === '{' || char === '[') {
      const key = top?.kind === 'object' && !top.expectingKey ? top.lastKey : undefined;
      stack.push({
        kind: char === '{' ? 'object' : 'array',
        key,
        expectingKey: true,
        lastKey: undefined,
      });
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      index += 1;
      continue;
    }
    if (char === ',') {
      if (top?.kind === 'object') top.expectingKey = true;
      index += 1;
      continue;
    }
    if (char === ':') {
      if (top?.kind === 'object') top.expectingKey = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      end += 1;
      const text = JSON.parse(source.slice(index, end)) as string;
      if (top?.kind === 'object' && top.expectingKey) {
        top.lastKey = text;
      } else if (
        top?.kind === 'object' && stack.length === 2 && top.key !== undefined &&
        sections.includes(top.key) && top.lastKey !== undefined
      ) {
        entries.push({ section: top.key, name: top.lastKey, value: text, start: index, end });
      }
      index = end;
      continue;
    }
    index += 1;
  }
  return entries;
}

/**
 * Rewrites every pre-0.9 framework pin in one manifest.
 *
 * Only an entry whose KEY is the same framework package its value names is
 * touched, so a hand-written alias pointing one name at another package is the
 * developer's and stays as written. Each rewrite replaces exactly the value's
 * literal, so comments, layout and every other entry are left byte-identical.
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
  const rewrites: PinRewrite[] = [];
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (const entry of sectionEntries(source, SECTIONS[manifest])) {
    const pkg = legacyFrameworkPackage(entry.value);
    if (pkg === undefined || entry.name !== `@setu-ts/${pkg}`) continue;
    const to = frameworkSpecifier(pkg, manifest);
    rewrites.push({ name: entry.name, from: entry.value, to });
    edits.push({ start: entry.start, end: entry.end, text: JSON.stringify(to) });
  }
  if (rewrites.length === 0) return { contents: undefined, rewrites };
  let contents = source;
  // From the end, so an earlier edit never shifts a later span.
  for (const edit of edits.reverse()) {
    contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
  }
  return { contents, rewrites };
}
