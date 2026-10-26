/** Feature activation uses the generator's original import-stripped rule. @module */
import { maskSourceCode } from '../devtool/sources.ts';
import { MODULES_EXPORT } from '../schematics/module-barrel.ts';
import { registerModuleSymbol } from '../seams/modules.ts';
import { deriveNames } from '../utils/names.ts';
import type { GeneratorMode } from '../utils/generator-mode.ts';

/**
 * Drops imports while preserving a following semicolonless statement.
 *
 * The same cut as `code.replace(/\bimport\b[^;]*?\bfrom\b/g, '')` — from an
 * `import` to the first `from` with no `;` between — computed in one pass over
 * the three tokens. The regular expression rescanned to the next `;` from every
 * `import`, so a config of repeated `import` words took 19 s at 1 MiB, and
 * `setu check` reads that file from a pull request (M118 audit F3).
 */
export function withoutImports(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  let kept = '';
  let copied = 0;
  let open = -1;
  for (const token of code.matchAll(/\bimport\b|\bfrom\b|;/g)) {
    if (token[0] === ';') open = -1;
    else if (token[0] === 'import') open = open < 0 ? token.index : open;
    else if (open >= 0) {
      kept += code.slice(copied, open);
      copied = token.index + token[0].length;
      open = -1;
    }
  }
  return kept + code.slice(copied);
}

/**
 * The element list of the first `MODULES … = [ … ]`, or undefined.
 *
 * Linear form of `/\bMODULES\b[^=]*=\s*\[([^\]]*)\]/`: every occurrence before
 * the same `=` shares its outcome, so each `=` is examined once (M118 audit F3:
 * the expression took 45 s on a 1 MiB activation barrel of `MODULES`).
 */
function modulesList(code: string): string | undefined {
  let examined = -1;
  for (const occurrence of code.matchAll(new RegExp(`\\b${MODULES_EXPORT}\\b`, 'g'))) {
    const after = occurrence.index + occurrence[0].length;
    if (after <= examined) continue;
    const equals = code.indexOf('=', after);
    if (equals < 0) return undefined;
    examined = equals;
    let open = equals + 1;
    while (/\s/.test(code.charAt(open))) open++;
    if (code[open] !== '[') continue;
    const close = code.indexOf(']', open + 1);
    return close < 0 ? undefined : code.slice(open + 1, close);
  }
  return undefined;
}

/** Whether the activation barrel calls a registrar or lists a class in MODULES. */
export function moduleActive(source: string, symbol: string, mode: GeneratorMode): boolean {
  const code = withoutImports(maskSourceCode(source));
  if (code === undefined) return false;
  if (mode !== 'class-based') return new RegExp(`\\b${symbol}\\s*\\(`).test(code);
  const listed = modulesList(code);
  return listed !== undefined && new RegExp(`\\b${symbol}\\b`).test(listed);
}

/** The mode-specific symbol declared by a feature module. */
export function moduleSymbol(module: string, mode: GeneratorMode): string {
  const names = deriveNames(module);
  return mode === 'class-based' ? `${names.pascal}Module` : registerModuleSymbol(names);
}
