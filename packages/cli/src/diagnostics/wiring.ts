/** Three-outcome config wiring inspection shared by the command renderers. @module */
import { maskSourceCode } from '../devtool/sources.ts';
import { hostSeamSpecs, scanSeamSpecs } from '../seams/registry.ts';
import { decoratorKeyFor, decoratorExportFor } from '../templates/seam.ts';
import { composingStarter } from '../utils/starter-arms.ts';
import type { Finding } from './diagnose.ts';

/** Imported bindings count, matching generate; the project's lint checks their use. */
export function classifyWiring(
  config: string,
  symbol: string,
): 'wired' | 'unwired' | 'unclassifiable' {
  const code = maskSourceCode(config);
  return code === undefined
    ? 'unclassifiable'
    : new RegExp(`\\b${symbol}\\b`).test(code)
      ? 'wired'
      : 'unwired';
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
  return {
    kind: 'unwired',
    barrel,
    symbols: missing,
    site,
    outcome: classifyWiring(config, missing[0]) === 'unclassifiable' ? 'unclassifiable' : 'unwired',
    ...(starter === undefined ? {} : { starter }),
  };
}
