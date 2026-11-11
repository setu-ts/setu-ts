/** Three-outcome config wiring inspection shared by the command renderers. @module */
import { maskSourceCode } from '../devtool/sources.ts';
import { referenceMask } from './reference-mask.ts';
import { hostSeamSpecs, scanSeamSpecs } from '../seams/registry.ts';
import { decoratorKeyFor, decoratorExportFor } from '../templates/seam.ts';
import { composingStarter } from '../utils/starter-arms.ts';
import type { Finding } from './diagnose.ts';
import { withoutImports } from './modules.ts';

/** Tests a value reference in code outside import declarations. */
export function referencedOutsideImports(config: string, symbol: string): boolean | undefined {
  const code = withoutImports(referenceMask(config));
  return code === undefined ? undefined : new RegExp(`\\b${symbol}\\b`).test(code);
}

/** Tests a call in code outside import declarations, matching module activation. */
export function calledOutsideImports(config: string, symbol: string): boolean | undefined {
  const code = withoutImports(referenceMask(config));
  return code === undefined ? undefined : new RegExp(`\\b${symbol}\\s*\\(`).test(code);
}

/**
 * The same call test through the strict, audited lexer, for a decision that
 * leads to an automatic edit (`setu workspace broker|rpc`): the tolerant
 * reference mask may only decide what a read-only check reports (V12-32,
 * M139d audit F2).
 */
export function strictlyCalledOutsideImports(config: string, symbol: string): boolean | undefined {
  const code = withoutImports(maskSourceCode(config));
  return code === undefined ? undefined : new RegExp(`\\b${symbol}\\s*\\(`).test(code);
}

/** The strict-lexer value-reference test, for a note an automatic edit prints. */
export function strictlyReferencedOutsideImports(
  config: string,
  symbol: string,
): boolean | undefined {
  const code = withoutImports(maskSourceCode(config));
  return code === undefined ? undefined : new RegExp(`\\b${symbol}\\b`).test(code);
}

/** Wiring requires a value use outside imports; registerModules requires a call. */
export function classifyWiring(
  config: string,
  symbol: string,
): 'wired' | 'unwired' | 'unclassifiable' {
  const used =
    symbol === 'registerModules'
      ? calledOutsideImports(config, symbol)
      : referencedOutsideImports(config, symbol);
  return used === undefined ? 'unclassifiable' : used ? 'wired' : 'unwired';
}

/** Builds the host's consumable barrel inventory, or generate's narrower legacy sites. */
export function wiringSites(
  installed: ReadonlySet<string>,
  generate: boolean,
): ReadonlyMap<string, { readonly symbols: readonly string[]; readonly site: string }> {
  const sites = new Map<string, { readonly symbols: readonly string[]; readonly site: string }>();
  for (const spec of generate ? scanSeamSpecs(installed) : hostSeamSpecs(installed)) {
    if (sites.has(spec.barrel)) continue;
    const key = decoratorKeyFor(spec);
    const symbol = decoratorExportFor(spec);
    if (generate && spec.barrel !== 'src/jobs/index.ts' && symbol === undefined) continue;
    sites.set(spec.barrel, {
      symbols: generate ? [symbol ?? 'QUEUE_PROCESSORS'] : spec.exports,
      site: key ?? (spec.barrel === 'src/jobs/index.ts' ? 'processors' : 'config'),
    });
  }
  if (!generate || !installed.has('decorator-plugin'))
    sites.set('src/modules/index.ts', {
      symbols: [installed.has('decorator-plugin') ? 'MODULES' : 'registerModules'],
      site: installed.has('decorator-plugin') ? 'modules' : 'registerModules',
    });
  return sites;
}

/** Makes one finding per unwired barrel, with a starter's decorators arm when applicable. */
export function wiringFinding(
  config: string,
  barrel: string,
  symbols: readonly string[],
  site: string,
): Finding | undefined {
  const missing = symbols.filter((symbol) => classifyWiring(config, symbol) !== 'wired');
  if (missing.length === 0) return undefined;
  const starter = composingStarter(config)?.symbol;
  const unusedImports = missing.filter(
    (symbol) =>
      referencedOutsideImports(config, symbol) === false &&
      new RegExp(`\\b${symbol}\\b`).test(referenceMask(config) ?? ''),
  );
  return {
    kind: 'unwired',
    barrel,
    symbols: missing,
    site,
    outcome: classifyWiring(config, missing[0]) === 'unclassifiable' ? 'unclassifiable' : 'unwired',
    ...(unusedImports.length === 0 ? {} : { unusedImports }),
    ...(starter === undefined ? {} : { starter }),
  };
}
