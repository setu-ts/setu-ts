/**
 * Rendering a plugin call at the width the generated project is formatted at.
 *
 * `setu add` inserts a provider call into a configuration it did not render
 * itself. On an npm target Prettier formats the edit afterwards; on Deno there
 * is no formatter in the CLI, and the call was written on one line however long
 * its options were — `MessagingPlugin({ broker: 'redis-streams', url: … })`
 * with a two-line connection read, a nested `options: { client: … }` — so the
 * project failed its own `deno fmt --check` on the first `setu add`.
 *
 * The same defect class as {@linkcode renderDeclarationHeader}, solved the same
 * way: the layout is derived from the rendered length rather than hand-wrapped
 * for the values the author happened to try. The options are parsed into the
 * few shapes the CLI writes — object and array literals, calls, `??` chains and
 * opaque atoms — and each node is printed on one line when it fits, and broken
 * the way `deno fmt` breaks it when it does not. `deno fmt` keeps an existing
 * line break, so a layout that only ever breaks what overflows is stable under
 * it; the table in `render-call.test.ts` holds each shape against a real
 * `deno fmt`.
 *
 * @module
 */

import { GENERATED_LINE_WIDTH as LINE_WIDTH } from '../templates/root-settings.ts';

/** One parsed piece of a CLI-authored argument expression. */
type Node =
  | { readonly kind: 'object'; readonly props: readonly Prop[] }
  | { readonly kind: 'array'; readonly items: readonly Node[] }
  | { readonly kind: 'call'; readonly callee: string; readonly args: readonly Node[] }
  | { readonly kind: 'chain'; readonly operator: string; readonly operands: readonly Node[] }
  | { readonly kind: 'spread'; readonly value: Node }
  | { readonly kind: 'atom'; readonly text: string };

/** An object member: `key: value`, or a spread or shorthand with no key. */
interface Prop {
  readonly key?: string;
  readonly value: Node;
}

/** Thrown for text outside the shapes the CLI writes; the caller keeps it as is. */
class Unparsed extends Error {}

/**
 * Splits text at top-level occurrences of a separator, outside quotes and brackets.
 *
 * @param text - The text to split
 * @param separator - The separator, matched literally
 * @returns The pieces, untrimmed
 * @throws {Unparsed} When a quote or bracket is left open
 */
function splitTopLevel(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(separator, index)) {
      pieces.push(text.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
    if (depth < 0) throw new Unparsed();
  }
  if (quote !== undefined || depth !== 0) throw new Unparsed();
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * Whether the bracket opening `text` closes at its last character, outside quotes.
 *
 * @param text - Text starting with `{`, `[` or `(`
 * @returns `true` when the first bracket encloses everything after it
 */
function enclosed(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let index = 0;
  // Stops on the bracket that closes the first one; past the end when none does.
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '{' || char === '[' || char === '(') depth += 1;
    else if ((char === '}' || char === ']' || char === ')') && --depth === 0) break;
  }
  return index === text.length - 1;
}

/**
 * Collapses whitespace runs outside quotes to one space.
 *
 * @param text - An atom's source text
 * @returns The text on one line
 */
function collapse(text: string): string {
  let out = '';
  let quote: string | undefined;
  let escaped = false;
  for (const char of text.trim()) {
    if (quote !== undefined) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
    } else if (/\s/.test(char)) {
      if (!out.endsWith(' ')) out += ' ';
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char;
      out += char;
    }
  }
  return out;
}

/**
 * The comma-separated members inside a bracket pair, without empty ones.
 *
 * @param body - The text between the brackets
 * @returns Each member, trimmed
 */
function members(body: string): string[] {
  return splitTopLevel(body, ',')
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '');
}

/**
 * Parses one CLI-authored expression.
 *
 * @param source - The expression's text
 * @returns Its parsed form
 * @throws {Unparsed} When it is not one of the shapes the CLI writes
 */
function parse(source: string): Node {
  const text = source.trim();
  if (text === '') throw new Unparsed();
  for (const operator of ['??', '||']) {
    const operands = splitTopLevel(text, operator);
    if (operands.length > 1) return { kind: 'chain', operator, operands: operands.map(parse) };
  }
  if (text.startsWith('...')) return { kind: 'spread', value: parse(text.slice(3)) };
  const close = text[text.length - 1];
  if (text.startsWith('{') && close === '}' && enclosed(text)) {
    return {
      kind: 'object',
      props: members(text.slice(1, -1)).map((member) => {
        const pair = splitTopLevel(member, ':');
        if (pair.length === 1) return { value: parse(member) };
        const key = pair[0]!.trim();
        if (!/^(?:[A-Za-z_$][\w$]*|'[^']*'|"[^"]*")$/.test(key)) throw new Unparsed();
        return { key, value: parse(pair.slice(1).join(':')) };
      }),
    };
  }
  if (text.startsWith('[') && close === ']' && enclosed(text)) {
    return { kind: 'array', items: members(text.slice(1, -1)).map(parse) };
  }
  const open = text.indexOf('(');
  const callee = open < 0 ? '' : text.slice(0, open).trim();
  // `f(a)(b)` and `f(a) + g(b)` end in `)` too; only one enclosing argument list is a call.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callee) && enclosed(text.slice(open))) {
    return { kind: 'call', callee, args: members(text.slice(open + 1, -1)).map(parse) };
  }
  return { kind: 'atom', text: collapse(text) };
}

/**
 * The one-line form of a node.
 *
 * @param node - The parsed node
 * @returns Its text on a single line
 */
function flat(node: Node): string {
  switch (node.kind) {
    case 'object':
      return node.props.length === 0
        ? '{}'
        : `{ ${node.props.map((prop) => (prop.key === undefined ? '' : `${prop.key}: `) + flat(prop.value)).join(', ')} }`;
    case 'array':
      return `[${node.items.map(flat).join(', ')}]`;
    case 'call':
      return `${node.callee}(${node.args.map(flat).join(', ')})`;
    case 'chain':
      return node.operands.map(flat).join(` ${node.operator} `);
    case 'spread':
      return `...${flat(node.value)}`;
    case 'atom':
      return node.text;
  }
}

/**
 * Lays out a node starting at `column` on a line indented by `indent`.
 *
 * @param node - The parsed node
 * @param indent - The indentation of the line the node starts on
 * @param column - The column the node's first character lands in
 * @param tail - Characters that follow the node on its last line
 * @returns The node's text; continuation lines carry their own indentation
 */
function layout(node: Node, indent: number, column: number, tail: number): string {
  const line = flat(node);
  if (column + line.length + tail <= LINE_WIDTH) return line;
  const inner = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);
  switch (node.kind) {
    case 'object':
      if (node.props.length === 0) return line;
      return `{\n${node.props
        .map((prop) => {
          const head = prop.key === undefined ? '' : `${prop.key}: `;
          return `${inner}${head}${layout(prop.value, indent + 2, indent + 2 + head.length, 1)},`;
        })
        .join('\n')}\n${close}}`;
    case 'array':
      if (node.items.length === 0) return line;
      return `[\n${node.items
        .map((item) => `${inner}${layout(item, indent + 2, indent + 2, 1)},`)
        .join('\n')}\n${close}]`;
    case 'call': {
      const only = node.args.length === 1 ? node.args[0]! : undefined;
      // A sole object or array argument hugs the parentheses, as `deno fmt` keeps
      // `CachePlugin({` … `})`.
      if (only !== undefined && (only.kind === 'object' || only.kind === 'array')) {
        const head = `${node.callee}(`;
        return `${head}${layout(only, indent, column + head.length, tail + 1)})`;
      }
      if (node.args.length === 0) return line;
      return `${node.callee}(\n${node.args
        .map((arg) => `${inner}${layout(arg, indent + 2, indent + 2, 1)},`)
        .join('\n')}\n${close})`;
    }
    case 'chain': {
      const operator = ` ${node.operator}`;
      const last = node.operands.length - 1;
      return node.operands
        .map((operand, index) =>
          index === 0
            ? layout(operand, indent, column, operator.length)
            : `${inner}${layout(operand, indent + 2, indent + 2, index === last ? tail : operator.length)}`,
        )
        .join(`${operator}\n`);
    }
    case 'spread':
    case 'atom':
      return line;
  }
}

/**
 * Renders `factory(args)` for a line indented by `indent`, breaking only what
 * does not fit before the trailing comma.
 *
 * @param factory - The provider factory's local name
 * @param args - The CLI-authored argument expression, or `''` for none
 * @param indent - The indentation of the line the call starts on
 * @returns The call, with no trailing comma; `factory(args)` unchanged when the
 * arguments are not a shape the CLI writes
 * @since 0.11.0
 */
export function renderPluginCall(factory: string, args: string, indent: number): string {
  if (args.trim() === '') return `${factory}()`;
  let parsed: Node;
  try {
    parsed = parse(args);
  } catch {
    // Only `Unparsed` reaches here: the parser throws nothing else.
    return `${factory}(${args})`;
  }
  return layout({ kind: 'call', callee: factory, args: [parsed] }, indent, indent, 1);
}
