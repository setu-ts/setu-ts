/** Conservative admission and placement of generated barrel imports. @module */
import type { LocalImport } from '../templates/registry.ts';
import { maskSourceCode, referencesIdentifier } from '../devtool/sources.ts';
import { lexImportSpecifiers } from './import-specifiers.ts';

/** Plans barrel imports; exclusive sources also refuse bindings named by another import. */
export function barrelImportPlan(
  source: string,
  imports: readonly LocalImport[],
  reuse: boolean,
  exclusiveSources = false,
): { text: string; at: number } | undefined {
  const lexed = lexImportSpecifiers(source);
  const code = maskSourceCode(source);
  if (lexed.kind !== 'ok' || code === undefined) return undefined;
  const declarations = lexed.spans.filter((span) => span.declaration !== undefined);
  const missing: string[] = [];
  for (const item of imports) {
    if (
      exclusiveSources &&
      declarations.some(
        (span) =>
          span.value !== item.from &&
          item.symbols.some((symbol) => span.declaration!.bindings.includes(symbol)),
      )
    )
      return undefined;
    const matching = declarations.filter((span) => span.value === item.from);
    if (matching.length > 0) {
      if (!reuse) return undefined;
      if (
        matching.length !== 1 ||
        matching[0]!.typeOnly ||
        !item.symbols.every((symbol) => matching[0]!.declaration!.named.includes(symbol))
      )
        return undefined;
    } else {
      if (item.symbols.some((symbol) => referencesIdentifier(code, symbol))) return undefined;
      missing.push(`import { ${item.symbols.join(', ')} } from '${item.from}';`);
    }
  }
  const end = Math.max(0, ...declarations.map((span) => span.declaration!.end));
  const lineEnd = end === 0 ? 0 : source.indexOf('\n', end);
  const at = lineEnd < 0 ? source.length : lineEnd;
  return { text: missing.length === 0 ? '' : `\n${missing.join('\n')}`, at };
}
