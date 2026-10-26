/** Feature activation uses the generator's original import-stripped rule. @module */
import { maskSourceCode } from '../devtool/sources.ts';
import { MODULES_EXPORT } from '../schematics/module-barrel.ts';
import { registerModuleSymbol } from '../seams/modules.ts';
import { deriveNames } from '../utils/names.ts';
import type { GeneratorMode } from '../utils/generator-mode.ts';

/** Drops imports while preserving a following semicolonless statement. */
export function withoutImports(code: string | undefined): string | undefined {
  return code?.replace(/\bimport\b[^;]*?\bfrom\b/g, '');
}

/** Whether the activation barrel calls a registrar or lists a class in MODULES. */
export function moduleActive(source: string, symbol: string, mode: GeneratorMode): boolean {
  const code = withoutImports(maskSourceCode(source));
  if (code === undefined) return false;
  if (mode !== 'class-based') return new RegExp(`\\b${symbol}\\s*\\(`).test(code);
  // A match always has its capture group, so `undefined` means only "no MODULES array".
  const listed = new RegExp(`\\b${MODULES_EXPORT}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(code)?.[1];
  return listed !== undefined && new RegExp(`\\b${symbol}\\b`).test(listed);
}

/** The mode-specific symbol declared by a feature module. */
export function moduleSymbol(module: string, mode: GeneratorMode): string {
  const names = deriveNames(module);
  return mode === 'class-based' ? `${names.pascal}Module` : registerModuleSymbol(names);
}
