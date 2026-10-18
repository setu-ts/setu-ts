/** Bounded, single-line rendering for caller-chosen names in diagnostics. */
export function renderDiagnosticName(name: string): string {
  return `${JSON.stringify(name.slice(0, 64))}${name.length > 64 ? '…' : ''}`;
}
