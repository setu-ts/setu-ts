/** Conservative edits to the full-stack callback shape emitted by this CLI. @module */
import {
  callArguments,
  callsIdentifier,
  maskComments,
  maskSourceCode,
  referencesIdentifier,
} from '../devtool/sources.ts';
import { reindentLiteral } from '../templates/plugin-args.ts';
import { composingStarter } from '../utils/starter-arms.ts';
import { barrelImportPlan } from '../utils/barrel-imports.ts';
import type { LocalImport } from '../templates/registry.ts';

/** The callback header every generated full-stack configuration carries (X5-2). */
const CALLBACK = /\(config\): FullStackStarterOptions => \{/g;

/** The depth the literal arrives at: a property of the generated returned object. */
const LITERAL_DEPTH = 8;

/**
 * Finds the brace closing the block that opens just before `from`.
 * @param code - Masked source, so braces in strings and comments are blank
 * @param from - The index just past the opening brace
 * @returns The index of the closing brace, or undefined when unbalanced
 */
function closingBrace(code: string, from: number): number | undefined {
  let depth = 1;
  for (let at = from; at < code.length; at++) {
    if (code[at] === '{') depth++;
    else if (code[at] === '}' && --depth === 0) return at;
  }
  return undefined;
}

/** The generated callback's returned object, located on masked code. */
interface IReturnedObject {
  /** Code with comments and literals masked, position for position. */
  readonly code: string;
  /** Code with comments masked and literals kept. */
  readonly visible: string;
  /** The index just past the object's opening brace. */
  readonly start: number;
  /** The index of the object's closing brace. */
  readonly end: number;
  /** Set for the generated callback when its body holds a `return` besides this one. */
  readonly otherReturns?: true;
}

/**
 * Finds the object the single `(config): FullStackStarterOptions => {` callback returns.
 *
 * Anchored on that callback itself, not on `factoryScope`: the generated full-stack factory
 * is `export async function createApp(…): Promise<IKernelApplication>`, which that shared
 * parser does not classify, and widening it would change what `withPluginWiring` and
 * `setu devtool enable` accept (M121 §3.7). Braces are counted on masked code, so a brace in
 * a string or comment cannot move the anchor.
 * @param source - Developer-owned configuration
 * @returns The object, or undefined when the shape is uncertain
 */
function returnedObject(source: string): IReturnedObject | undefined {
  const code = maskSourceCode(source);
  const visible = maskComments(source);
  if (code === undefined || visible === undefined) return undefined;
  if (composingStarter(source)?.symbol !== 'createFullStackAppFromConfig') return undefined;
  if (!callsIdentifier(code, 'createFullStackAppFromConfig')) return undefined;

  const callbacks = [...code.matchAll(CALLBACK)];
  if (callbacks.length !== 1) return undefined;
  const bodyStart = callbacks[0]!.index + callbacks[0]![0].length;
  const bodyEnd = closingBrace(code, bodyStart);
  if (bodyEnd === undefined) return undefined;

  // Exactly one `return {` directly in the callback body (depth 1).
  let returned: number | undefined;
  let depth = 1;
  for (let at = bodyStart; at < bodyEnd; at++) {
    if (depth === 1 && /^return\b/.test(code.slice(at, at + 7)) && !/[\w$]/.test(code[at - 1]!)) {
      if (returned !== undefined) return undefined;
      const match = /^return\s*\{/.exec(code.slice(at));
      if (match === null) return undefined;
      returned = at + match[0].length;
    }
    if (code[at] === '{') depth++;
    else if (code[at] === '}') depth--;
  }
  if (returned === undefined) return undefined;
  // The callback body balances, so the object opened inside it closes inside it too.
  const returns = [...code.slice(bodyStart, bodyEnd).matchAll(/(?<![\w$.])return\b/g)].length;
  return {
    code,
    visible,
    start: returned,
    end: closingBrace(code, returned)!,
    ...(returns > 1 ? { otherReturns: true as const } : {}),
  };
}

/**
 * Finds the object literal passed as the first argument of the starter's single call.
 *
 * Read-only: it lets guidance report an option a hand-written `createMicroserviceApp({ … })`
 * already sets (PR #519 review). Edits stay on {@linkcode returnedObject}, the generated shape.
 * @param source - Developer-owned configuration
 * @returns The object, or undefined when there is not exactly one such call
 */
function callObject(source: string): IReturnedObject | undefined {
  const code = maskSourceCode(source);
  const visible = maskComments(source);
  const symbol = composingStarter(source)?.symbol;
  if (code === undefined || visible === undefined || symbol === undefined) return undefined;
  if (callArguments(code, symbol).length !== 1) return undefined;
  const calls = [...code.matchAll(new RegExp(`(?<![\\w$.])${symbol}\\s*\\(\\s*\\{`, 'g'))];
  if (calls.length !== 1) return undefined;
  const start = calls[0]!.index + calls[0]![0].length;
  const end = closingBrace(code, start);
  return end === undefined ? undefined : { code, visible, start, end };
}

/**
 * Calls `visit` for each top-level position of the returned object, with its nesting depth.
 * @param object - The located object
 * @param visit - Receives the index and the depth relative to the object (0 = its properties)
 */
function walkTopLevel(object: IReturnedObject, visit: (at: number, depth: number) => void): void {
  let depth = 0;
  for (let at = object.start; at < object.end; at++) {
    visit(at, depth);
    const c = object.code[at];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
  }
}

/**
 * Reads the source text of a top-level property of the starter's options object.
 *
 * The generated callback is read with the same analysis {@linkcode withStarterOption} edits
 * through, so guidance and edits agree (PR #519 review); otherwise the object passed to the
 * starter's single call, such as `createMicroserviceApp({ … })`. The key may be quoted.
 * @param source - Developer-owned configuration
 * @param key - Starter option to read
 * @returns The property's value text, or undefined when absent or the shape is uncertain
 */
export function starterOptionValue(
  source: string,
  key: 'messaging' | 'queue' | 'events' | 'cqrs',
): string | undefined {
  const object = returnedObject(source) ?? callObject(source);
  if (object === undefined) return undefined;
  const property = new RegExp(`^(['"]?)${key}\\1\\s*:`);
  let valueStart: number | undefined;
  let valueEnd = object.end;
  walkTopLevel(object, (at, depth) => {
    if (depth !== 0) return;
    if (valueStart === undefined) {
      if (/[\w$'"]/.test(object.visible[at - 1] ?? '')) return;
      const match = property.exec(object.visible.slice(at));
      if (match !== null) valueStart = at + match[0].length;
    } else if (at >= valueStart && object.code[at] === ',' && valueEnd === object.end) {
      valueEnd = at;
    }
  });
  return valueStart === undefined ? undefined : source.slice(valueStart, valueEnd).trim();
}

/** A value that leaves a gated starter arm off. */
const UNSET_VALUE = /^(?:undefined|null|false)$/;

/**
 * Whether the starter's options set an arm, for `setu check`'s unregistered-plugin warning.
 *
 * Read from the generated callback's returned object, else from the object passed to the
 * starter's single call; a single call with no argument sets nothing. A dotted arm
 * (`realtime.websocket`) is read inside its parent's object literal. Any shape the masked
 * walker cannot split into `key: value` entries (a top-level spread, a method, a parent arm
 * that is not a literal), and a callback with another `return` (which may return a different
 * object), answers `undefined`, so the check stays quiet rather than guessing.
 * @param source - Developer-owned configuration
 * @param arm - The starter option, as `STARTER_ARMS` names it
 * @param presenceOnly - Count an existing key even when its value disables the arm
 * @returns `true` when set (or present in presence-only mode), `false` when absent or disabled,
 *   `undefined` when unknown
 */
export function starterArmSet(
  source: string,
  arm: string,
  presenceOnly = false,
): boolean | undefined {
  const object = returnedObject(source) ?? callObject(source);
  if (object === undefined) {
    const code = maskSourceCode(source);
    const symbol = composingStarter(source)?.symbol;
    if (code === undefined || symbol === undefined) return undefined;
    const calls = callArguments(code, symbol);
    return calls.length === 1 && calls[0]!.trim() === '' ? false : undefined;
  }
  if (object.otherReturns === true) return undefined;
  const entries = literalEntries(object);
  if (entries === undefined) return undefined;
  const [parent = arm, child] = arm.split('.');
  const entry = entries.find(({ key }) => key === parent);
  if (entry === undefined) return false;
  // Comments masked (offsets unchanged), so `undefined /* off */` still reads as unset.
  const value = object.visible.slice(entry.start, entry.end).trim();
  if (child === undefined) return presenceOnly || !UNSET_VALUE.test(value);
  if (UNSET_VALUE.test(value)) return false;
  const inner = starterLiteralEntries(value);
  if (inner === undefined) return undefined;
  const nested = inner.find(([key]) => key === child);
  return nested !== undefined && (presenceOnly || !UNSET_VALUE.test(nested[1]));
}

/**
 * Inserts an absent option and its imports into the single generated typed callback.
 *
 * Existing parent keys and uncertain literals refuse the edit, including spreads that could
 * already supply the arm. Calls without seam imports retain the conservative text-mention check;
 * seam edits check parsed keys and code, so URL strings such as '/metrics' are not option keys.
 * @param source - Developer-owned configuration
 * @param key - Starter option to insert; dotted paths are wrapped in nested literals
 * @param literal - Option literal, indented for an eight-space property
 * @param imports - Generated barrel bindings to reuse or add atomically with the option
 * @returns Edited source, or undefined when the shape or absence is uncertain
 */
export function withStarterOption(
  source: string,
  key: string,
  literal: string,
  imports: readonly LocalImport[] = [],
): string | undefined {
  const object = returnedObject(source);
  if (object === undefined || object.otherReturns === true) return undefined;
  const entries = literalEntries(object);
  if (entries === undefined) return undefined;
  const parts = key.split('.');
  if (parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part))) return undefined;
  const parent = parts[0]!;
  const mentions = imports.length === 0 ? object.visible : object.code;
  if (
    entries.some(({ key }) => key === parent) ||
    referencesIdentifier(mentions.slice(object.start, object.end), parent)
  )
    return undefined;
  const plan = barrelImportPlan(source, imports, true, true);
  if (plan === undefined) return undefined;

  // The property sits two spaces inside the line that holds `return {`.
  const returned = object.start;
  const lineStart = source.lastIndexOf('\n', returned - 1) + 1;
  const indent = /^ */.exec(source.slice(lineStart))![0].length + 2;
  const nested = parts.slice(1).reduceRight((value, child) => `{ ${child}: ${value} }`, literal);
  const value = reindentLiteral(nested, LITERAL_DEPTH, indent);
  const inserted = `\n${' '.repeat(indent)}${parent}: ${value},`;
  const edited = `${source.slice(0, returned)}${inserted}${source.slice(returned)}`;
  const at = plan.at > returned ? plan.at + inserted.length : plan.at;
  return `${edited.slice(0, at)}${plan.text}${edited.slice(at)}`;
}

/** Splits a located literal with the existing masked top-level walker. */
function literalEntries(
  object: IReturnedObject,
  callSpread = false,
): readonly { key: string; start: number; end: number }[] | undefined {
  const boundaries = [object.start];
  walkTopLevel(object, (at, depth) => {
    if (depth === 0 && object.code[at] === ',') boundaries.push(at + 1);
  });
  boundaries.push(object.end + 1);
  const entries: { key: string; start: number; end: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]! - 1;
    const text = object.visible.slice(start, end);
    if (text.trim() === '') continue;
    // M138 §3.4: one keyless spread of a one-argument call, `...queueOptions(config)`,
    // is how a workspace member's starter arm reads its CLI-owned transport module.
    // Kept as an opaque entry; anything else that is not `key: value` still fails.
    if (callSpread && /^\s*\.\.\.[A-Za-z_$][\w$]*\(\s*[A-Za-z_$][\w$]*\s*\)\s*$/.test(text)) {
      if (entries.some((entry) => entry.key === '...')) return undefined;
      entries.push({ key: '...', start, end });
      continue;
    }
    const match = /^\s*(?:([A-Za-z_$][\w$]*)|'([^']+)'|"([^"]+)")\s*:\s*/.exec(text);
    if (match === null) return undefined;
    const key = match[1] ?? match[2] ?? match[3]!;
    if (entries.some((entry) => entry.key === key)) return undefined;
    entries.push({ key, start: start + match[0].length, end });
  }
  return entries;
}

/** Reads entries of a CLI-authored options literal using the shared masked walker. */
export function starterLiteralEntries(
  literal: string,
): readonly (readonly [string, string])[] | undefined {
  const code = maskSourceCode(literal);
  const visible = maskComments(literal);
  if (
    code === undefined ||
    visible === undefined ||
    !code.startsWith('{') ||
    closingBrace(code, 1) !== code.length - 1
  )
    return undefined;
  const entries = literalEntries({ code, visible, start: 1, end: code.length - 1 });
  return entries?.map(({ key, start, end }) => [key, literal.slice(start, end).trim()] as const);
}

/**
 * Adds one absent property to a starter arm without replacing developer-owned values.
 * @param source - Configuration source
 * @param key - Starter arm
 * @param property - Property to add
 * @param value - Source expression for its value
 * @returns Edited source, or undefined for an existing property or uncertain shape
 */
export function withStarterArmEntry(
  source: string,
  key: 'events' | 'cqrs' | 'queue' | 'messaging',
  property: string,
  value: string,
): string | undefined {
  const object = returnedObject(source);
  if (object === undefined) return undefined;
  const entries = literalEntries(object);
  if (entries === undefined) return undefined;
  const arm = entries.find((entry) => entry.key === key);
  if (arm === undefined) return withStarterOption(source, key, `{ ${property}: ${value} }`);
  if (object.code[arm.start] !== '{') return undefined;
  const end = closingBrace(object.code, arm.start + 1);
  if (end === undefined || source.slice(end + 1, arm.end).trim() !== '') return undefined;
  const inner = { ...object, start: arm.start + 1, end };
  const properties = literalEntries(inner, true);
  if (properties === undefined || properties.some((entry) => entry.key === property))
    return undefined;
  const lineStart = source.lastIndexOf('\n', arm.start) + 1;
  const indent = /^ */.exec(source.slice(lineStart))![0].length + 2;
  const rendered = reindentLiteral(value, 10, indent);
  const padding = ' '.repeat(indent);
  let body = source.slice(inner.start, end).trimEnd();
  if (!body.includes('\n')) {
    // Expanding a single-line arm must split its top-level properties, not nested commas.
    const starts = [inner.start];
    walkTopLevel(inner, (at, depth) => {
      if (depth === 0 && object.code[at] === ',') starts.push(at + 1);
    });
    starts.push(end + 1);
    body = starts
      .slice(0, -1)
      .map((start, index) => {
        const stop = starts[index + 1]! - 1;
        const text = source.slice(start, stop).trim();
        if (text === '') return '';
        const comma = object.visible.slice(start, stop).trim() === '' ? '' : ',';
        return `\n${padding}${text}${comma}`;
      })
      .join('');
  } else if (properties.length > 0) {
    // Add a missing trailing comma before any end-of-line comment.
    let last = end - 1;
    while (last >= inner.start && object.visible[last]!.trim() === '') last--;
    if (object.code[last] !== ',') {
      const relative = last + 1 - inner.start;
      body = `${body.slice(0, relative)},${body.slice(relative)}`;
    }
  }
  return `${source.slice(0, inner.start)}${body}\n${padding}${property}: ${rendered},\n${' '.repeat(indent - 2)}${source.slice(end)}`;
}
