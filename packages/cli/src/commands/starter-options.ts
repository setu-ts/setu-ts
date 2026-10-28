/** Conservative edits to the full-stack callback shape emitted by this CLI. @module */
import {
  callsIdentifier,
  maskComments,
  maskSourceCode,
  referencesIdentifier,
} from '../devtool/sources.ts';
import { reindentLiteral } from '../templates/plugin-args.ts';
import { composingStarter } from '../utils/starter-arms.ts';

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
  return { code, visible, start: returned, end: closingBrace(code, returned)! };
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
 * Reads the source text of a top-level property of the generated returned object.
 *
 * The same callback analysis {@linkcode withStarterOption} edits through, so guidance and
 * edits agree on what the starter is configured with (PR #519 review). The key may be quoted.
 * @param source - Developer-owned configuration
 * @param key - Starter option to read
 * @returns The property's value text, or undefined when absent or the shape is uncertain
 */
export function starterOptionValue(source: string, key: 'messaging' | 'queue'): string | undefined {
  const object = returnedObject(source);
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

/**
 * Inserts an absent transport option into the single generated typed callback.
 *
 * A mention of the key anywhere in the returned object, even in a string, refuses the edit
 * (fail closed), as does a top-level spread that could already supply it.
 * @param source - Developer-owned configuration
 * @param key - Starter option to insert
 * @param literal - Option literal, indented for an eight-space property
 * @returns Edited source, or undefined when the shape or absence is uncertain
 */
export function withStarterOption(
  source: string,
  key: 'messaging' | 'queue',
  literal: string,
): string | undefined {
  const object = returnedObject(source);
  if (object === undefined) return undefined;
  if (referencesIdentifier(object.visible.slice(object.start, object.end), key)) return undefined;

  // A top-level spread can already supply the key, so its value is not ours to infer.
  // Nested spreads belong to the generated reactRouter and httpSecurity arms.
  let spread = false;
  walkTopLevel(object, (at, depth) => {
    if (depth === 0 && object.code.startsWith('...', at)) spread = true;
  });
  if (spread) return undefined;

  // The property sits two spaces inside the line that holds `return {`.
  const returned = object.start;
  const lineStart = source.lastIndexOf('\n', returned - 1) + 1;
  const indent = /^ */.exec(source.slice(lineStart))![0].length + 2;
  const value = reindentLiteral(literal, LITERAL_DEPTH, indent);
  return `${source.slice(0, returned)}\n${' '.repeat(indent)}${key}: ${value},${source.slice(returned)}`;
}
