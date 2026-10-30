/**
 * Adds a generated class to a class-based module's `@Module` declaration.
 *
 * `<module>.module.ts` is the developer's file. The CLI edits it only in the
 * shapes it can read exactly, following the NestJS CLI (`@nestjs/schematics`
 * `utils/metadata.manager.js`): a missing `controllers` or `providers` property
 * is added, a plain array literal gets the class appended (once), and anything
 * else is left unchanged. Unchanged means the caller prints the line to add, so
 * an uncertain edit never corrupts the declaration.
 *
 * Positions are read from masked source, so a bracket, a comma or a property
 * name inside a string or a comment can never move an edit.
 *
 * @module
 */
import { maskComments, maskSourceCode, referencesIdentifier } from '../devtool/sources.ts';
import { afterLastImport } from './import-placement.ts';
import { lexImportSpecifiers } from './import-specifiers.ts';

/** The two `@Module` arrays a generated class joins. */
export type ModuleDeclarationProperty = 'controllers' | 'providers';

/** What the edit did. */
export type ModuleDeclarationEdit =
  | { readonly kind: 'edited'; readonly source: string }
  | { readonly kind: 'present' }
  | { readonly kind: 'unreadable' };

const OPENERS: Readonly<Record<string, string>> = { '{': '}', '[': ']', '(': ')' };

/**
 * Finds the index of the bracket closing the one at `open`.
 *
 * @param code - Masked source
 * @param open - The index of an opening `{`, `[` or `(`
 * @returns The closing index, or undefined when unbalanced
 */
function closing(code: string, open: number): number | undefined {
  const stack: string[] = [];
  for (let at = open; at < code.length; at++) {
    const c = code[at]!;
    if (OPENERS[c] !== undefined) stack.push(OPENERS[c]);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== c) return undefined;
      if (stack.length === 0) return at;
    }
  }
  return undefined;
}

/**
 * Splits the code between two offsets at its top-level commas.
 *
 * @param code - Masked source
 * @param start - The first offset inside the brackets
 * @param end - The offset of the closing bracket
 * @returns Each entry's start and end offsets
 */
function topLevelEntries(
  code: string,
  start: number,
  end: number,
): readonly { readonly start: number; readonly end: number }[] {
  const entries: { start: number; end: number }[] = [];
  let depth = 0;
  let from = start;
  for (let at = start; at < end; at++) {
    const c = code[at]!;
    if (OPENERS[c] !== undefined) depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      entries.push({ start: from, end: at });
      from = at + 1;
    }
  }
  entries.push({ start: from, end });
  return entries.filter((entry) => code.slice(entry.start, entry.end).trim() !== '');
}

/**
 * Adds `symbol` to the declaration's `property` array and imports it.
 *
 * @param source - The current `<module>.module.ts`
 * @param property - `controllers` for a class controller, `providers` for a service
 * @param symbol - The class to add
 * @param specifier - The relative module the class is imported from
 * @returns The edited source; `present` when the class is already listed; or
 *   `unreadable` when the declaration is not a shape the CLI edits
 */
export function withModuleDeclarationEntry(
  source: string,
  property: ModuleDeclarationProperty,
  symbol: string,
  specifier: string,
): ModuleDeclarationEdit {
  const code = maskSourceCode(source);
  const visible = maskComments(source);
  if (code === undefined || visible === undefined) return { kind: 'unreadable' };

  const decorators = [...code.matchAll(/@Module\s*\(/g)];
  if (decorators.length !== 1) return { kind: 'unreadable' };
  const call = decorators[0]!;
  const open = /^\s*/.exec(code.slice(call.index + call[0].length))![0].length;
  const objectStart = call.index + call[0].length + open;
  if (code[objectStart] !== '{') return { kind: 'unreadable' };
  const objectEnd = closing(code, objectStart);
  if (objectEnd === undefined) return { kind: 'unreadable' };

  const entries = topLevelEntries(code, objectStart + 1, objectEnd);
  // A quoted or computed key, or a spread, could already carry the property
  // under a form this reader cannot see, so adding one could duplicate it.
  if (
    !entries.every((entry) =>
      /^\s*[A-Za-z_$][\w$]*\s*(?::|$)/.test(code.slice(entry.start, entry.end)),
    )
  )
    return { kind: 'unreadable' };
  const named = entries.filter((entry) =>
    new RegExp(`^\\s*${property}\\b`).test(code.slice(entry.start, entry.end)),
  );
  if (named.length > 1) return { kind: 'unreadable' };

  let edited: string;
  if (named.length === 0) {
    // Absent: added as the first property, as the NestJS CLI does.
    edited = `${source.slice(0, objectStart + 1)}\n  ${property}: [${symbol}],${source.slice(objectStart + 1)}`;
  } else {
    const entry = named[0]!;
    const value = new RegExp(`^\\s*${property}\\s*:\\s*`).exec(code.slice(entry.start, entry.end));
    // A shorthand property or a computed value is not an array the CLI can read.
    if (value === null) return { kind: 'unreadable' };
    const arrayStart = entry.start + value[0].length;
    if (code[arrayStart] !== '[') return { kind: 'unreadable' };
    const arrayEnd = closing(code, arrayStart);
    if (arrayEnd === undefined || code.slice(arrayEnd + 1, entry.end).trim() !== '')
      return { kind: 'unreadable' };
    const items = topLevelEntries(code, arrayStart + 1, arrayEnd).map((item) =>
      code.slice(item.start, item.end).trim(),
    );
    // Only bare identifiers: a spread or a call can already include the class.
    if (!items.every((item) => /^[A-Za-z_$][\w$]*$/.test(item))) return { kind: 'unreadable' };
    if (items.includes(symbol)) return { kind: 'present' };
    let last = arrayEnd - 1;
    while (last > arrayStart && /\s/.test(code[last]!)) last--;
    const insertion =
      last === arrayStart ? symbol : code[last] === ',' ? ` ${symbol},` : `, ${symbol}`;
    edited = `${source.slice(0, last + 1)}${insertion}${source.slice(last + 1)}`;
  }

  // The class must arrive by this one import; any other binding of the name
  // would shadow it or collide with it.
  if (referencesIdentifier(visible, symbol)) return { kind: 'unreadable' };
  const editedVisible = maskComments(edited)!;
  const at = afterLastImport(edited, editedVisible);
  if (at === undefined) return { kind: 'unreadable' };
  const line = `import { ${symbol} } from '${specifier}';`;
  return {
    kind: 'edited',
    source:
      at === 0 ? `${line}\n\n${edited}` : `${edited.slice(0, at)}\n${line}${edited.slice(at)}`,
  };
}

/**
 * Re-points a module declaration's imports at controllers and services that
 * moved within the module, the step `setu sync` takes after a developer moves a
 * file into a subfolder.
 *
 * Only an import that no longer resolves, of a `.controller.ts` or `.service.ts`
 * file whose base name matches exactly ONE file in the module, is rewritten; the
 * duplicate-name rule (`setu.E016`) keeps that match unique. Anything else is
 * left for `setu check` to report.
 *
 * @param source - The current `<module>.module.ts`
 * @param files - Every file in the module, relative to the module directory
 * @returns The rewritten declaration, or undefined when nothing needs to change
 */
export function withRelocatedDeclarationImports(
  source: string,
  files: readonly string[],
): string | undefined {
  const lexed = lexImportSpecifiers(source);
  if (lexed.kind !== 'ok') return undefined;
  const present = new Set(files);
  let edited = source;
  for (const span of [...lexed.spans].sort((a, b) => b.start - a.start)) {
    if (!span.value.startsWith('./') || !/\.(?:controller|service)\.ts$/.test(span.value)) continue;
    const target = span.value.slice(2);
    if (present.has(target)) continue;
    const base = target.slice(target.lastIndexOf('/') + 1);
    const matches = files.filter((file) => file === base || file.endsWith(`/${base}`));
    if (matches.length !== 1) continue;
    const quote = source[span.start]!;
    edited = `${edited.slice(0, span.start)}${quote}./${matches[0]!}${quote}${edited.slice(span.end)}`;
  }
  return edited === source ? undefined : edited;
}
