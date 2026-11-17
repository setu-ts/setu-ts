/** Conservative admission and placement of generated barrel imports. @module */
import type { LocalImport } from '../templates/registry.ts';
import { maskComments, referencesIdentifier } from '../devtool/sources.ts';
import { afterLastImport } from './import-placement.ts';

/** Plans barrel imports; exclusive sources also refuse bindings named by another import. */
export function barrelImportPlan(
  source: string,
  imports: readonly LocalImport[],
  reuse: boolean,
  exclusiveSources = false,
): { text: string; at: number } | undefined {
  const visible = maskComments(source);
  if (visible === undefined) return undefined;
  const missing: string[] = [];
  for (const item of imports) {
    if (
      exclusiveSources &&
      [...visible.matchAll(/\bimport\s+([^;]+?)\s+from\s*(['"])([^'"]+)\2/g)].some(
        (match) =>
          match[3] !== item.from &&
          item.symbols.some((symbol) => referencesIdentifier(match[1]!, symbol)),
      )
    )
      return undefined;
    const mentioned = visible.includes(`'${item.from}'`) || visible.includes(`"${item.from}"`);
    if (mentioned) {
      if (!reuse) return undefined;
      const declarations = [
        ...visible.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g),
      ].filter((match) => match[3] === item.from);
      if (
        declarations.length !== 1 ||
        !item.symbols.every((symbol) =>
          declarations[0]![1]!
            .split(',')
            .map((name) => name.trim())
            .includes(symbol),
        )
      )
        return undefined;
    } else {
      if (item.symbols.some((symbol) => referencesIdentifier(visible, symbol))) return undefined;
      missing.push(`import { ${item.symbols.join(', ')} } from '${item.from}';`);
    }
  }
  const at = afterLastImport(source, visible);
  if (at === undefined) return undefined;
  return { text: missing.length === 0 ? '' : `\n${missing.join('\n')}`, at };
}
