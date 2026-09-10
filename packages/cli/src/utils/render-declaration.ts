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
  return `${declaration}\n  ${keyword}\n    ${rest} {`;
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
