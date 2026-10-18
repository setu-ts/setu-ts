/**
 * Bounded, single-line rendering for caller-chosen names in diagnostics.
 *
 * Takes `unknown` because a JavaScript caller may forward a JSON value where a
 * field name is typed: a non-string renders as its type rather than throwing
 * (M113g audit round 3, L7).
 */
export function renderDiagnosticName(name: unknown): string {
  if (typeof name !== 'string') return `<${name === null ? 'null' : typeof name}>`;
  return `${JSON.stringify(name.slice(0, 64))}${name.length > 64 ? '…' : ''}`;
}
