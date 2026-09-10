/**
 * Rendering a class declaration at the width the generated project is
 * formatted at.
 *
 * The code counterpart of {@linkcode wrapProse}, and the same defect class:
 * hand-wrapping inside a template literal is only correct for the exact values
 * the author happened to interpolate. `setu generate query-handler` wrapped its
 * `implements` clause UNCONDITIONALLY, so whether the emitted file satisfied
 * the project's own `deno fmt --check` depended on how long the artifact's name
 * happened to be — `find-order` joins to 92 characters and the formatter
 * rejoins it, while `place-order` joins to 103 and the wrap is correct (V5-3).
 * That is M63's D6 and M70h's X2-4 one more time.
 *
 * Deriving the decision from the rendered length removes the class rather than
 * the instance: the output no longer depends on the name.
 *
 * @module
 */

import { GENERATED_LINE_WIDTH as LINE_WIDTH } from '../templates/root-settings.ts';

/**
 * Renders `<declaration> <clause> {`, wrapped only when the one-line form
 * would overflow.
 *
 * Takes both halves as opaque text rather than a name plus a keyword, so the
 * one implementation covers `export class X implements Y` and
 * `export interface X extends Y` without a keyword taxonomy — both shapes
 * appear in the generated handlers and both overflowed.
 *
 * The wrapped form matches `deno fmt`'s own output exactly — the clause moves
 * to its own line at a two-space indent, with the brace staying on it —
 * MEASURED against a real `deno fmt` at `lineWidth: 100` on both sides of the
 * boundary rather than inferred: a 92-character header is joined and a
 * 103-character one is wrapped this way.
 *
 * @param declaration - Everything before the clause, e.g. `export class Foo`
 * @param clause - The clause with its keyword, e.g. `implements IBar<A, B>`
 * @returns The declaration line(s), with no trailing newline
 * @since 0.6.0
 */
export function renderDeclarationHeader(declaration: string, clause: string): string {
  const oneLine = `${declaration} ${clause} {`;
  if (oneLine.length <= LINE_WIDTH) {
    return oneLine;
  }
  // The clause on its own line at two spaces. Still not always enough — a long
  // artifact name puts a two-type generic past the width even there, and the
  // formatter then splits the keyword from the type. Three forms rather than
  // two because that third case is REACHED by a realistic name
  // (`outbound-payment-reconciliation`), not because the formatter has three.
  const wrapped = `  ${clause} {`;
  if (wrapped.length <= LINE_WIDTH) {
    return `${declaration}\n${wrapped}`;
  }
  const keyword = clause.slice(0, clause.indexOf(' '));
  const rest = clause.slice(clause.indexOf(' ') + 1);
  const split = `    ${rest} {`;
  if (split.length <= LINE_WIDTH) {
    return `${declaration}\n  ${keyword}\n${split}`;
  }
  // Forms four and five split the type ARGUMENTS, and form four is the one
  // nobody would guess: the keyword goes BACK onto the declaration line.
  // Measured against a real `deno fmt` by sweeping the name length rather than
  // reasoned about — the keyword returning to line one is the opposite of what
  // forms two and three would suggest. Form five is reached once even
  // `<declaration> <keyword>` overflows: the keyword returns to its own line
  // and the whole expansion indents one level deeper.
  const open = rest.indexOf('<');
  if (open === -1 || !rest.endsWith('>')) {
    // Not a generic, so there is nothing left to split; the formatter leaves
    // this alone too, since a bare over-width identifier cannot be shortened.
    return `${declaration}\n  ${keyword}\n${split}`;
  }
  // Which of the two the formatter picks turns on whether the OPENING line of
  // the expansion — declaration, keyword, type head and its `<` — still fits.
  // Not on the declaration's own length, which is comfortably inside the width
  // in both cases: measured by sweeping the name one character at a time, the
  // switch lands exactly where this sum crosses the width.
  const head = rest.slice(0, open + 1);
  if (`${declaration} ${keyword} ${head}`.length <= LINE_WIDTH) {
    return `${declaration} ${keyword}\n${expandTypeArguments(rest, 2)} {`;
  }
  return `${declaration}\n  ${keyword}\n${expandTypeArguments(rest, 4)} {`;
}

/**
 * Splits a generic type reference across lines the way `deno fmt` does when
 * even its own line will not fit.
 *
 * @param type - The type reference, e.g. `ICommandHandler<A, B>`
 * @param indent - Spaces before the head; arguments sit two deeper
 * @returns The expanded form. The caller has already established that `type`
 *   is a generic reference.
 */
function expandTypeArguments(type: string, indent: number): string {
  const open = type.indexOf('<');
  const head = type.slice(0, open);
  const args = splitTopLevel(type.slice(open + 1, -1));
  const pad = ' '.repeat(indent);
  const argPad = ' '.repeat(indent + 2);
  return `${pad}${head}<\n${args.map((a) => `${argPad}${a}`).join(',\n')}\n${pad}>`;
}

/**
 * Splits a type-argument list on its top-level commas.
 *
 * Depth-aware, so a nested generic or a tuple argument stays whole — the
 * generated handlers use flat arguments today, but a renderer that split
 * `Map<K, V>` in half would emit source that does not parse.
 *
 * @param args - The text between the angle brackets
 * @returns The arguments, trimmed
 */
function splitTopLevel(args: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '<' || ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === '>' || ch === ']' || ch === ')' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last !== '') out.push(last);
  return out;
}

/**
 * Renders a method signature at a two-space indent, expanded only when the
 * one-line form would overflow.
 *
 * The same rule as {@linkcode renderDeclarationHeader} applied to the other
 * line in a generated handler whose length tracks the artifact's name: a
 * handler for `outbound-payment-reconciliation` has both its parameter and its
 * return type named after it, so `handle(command: X): Promise<Y> {` passes the
 * width while `handle(command: A): Promise<B> {` does not.
 *
 * The expanded form matches `deno fmt` exactly — parameters at four spaces
 * with a trailing comma, the return type back at two.
 *
 * @param name - The method name
 * @param params - Each parameter as `name: Type`
 * @param returnType - The return type, without the colon
 * @returns The signature line(s) at a two-space indent, no trailing newline
 * @since 0.6.0
 */
export function renderMethodSignature(
  name: string,
  params: readonly string[],
  returnType: string,
): string {
  const oneLine = `  ${name}(${params.join(', ')}): ${returnType} {`;
  if (oneLine.length <= LINE_WIDTH) {
    return oneLine;
  }
  return `  ${name}(\n    ${params.join(',\n    ')},\n  ): ${returnType} {`;
}

/**
 * Renders `export const NAME = <value>;`, wrapped only when the one-line form
 * would overflow.
 *
 * The third line kind in a generated handler whose length tracks the
 * artifact's name, and the last one to break: a `SCREAMING_SNAKE` constant
 * named after the artifact, assigned its own name as a string. Measured
 * against a real `deno fmt` — the value moves to its own line at two spaces
 * and the declaration keeps the `=`.
 *
 * @param name - The constant's name
 * @param value - The rendered value, e.g. a quoted string literal
 * @returns The declaration line(s), no trailing newline
 * @since 0.6.0
 */
export function renderConstAssignment(name: string, value: string): string {
  const oneLine = `export const ${name} = ${value};`;
  if (oneLine.length <= LINE_WIDTH) {
    return oneLine;
  }
  return `export const ${name} =\n  ${value};`;
}
