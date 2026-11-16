import { CONFIGURED_PROVIDERS, ZERO_CONFIG_WIRINGS } from '../utils/plugin-wirings.ts';
/** Three-outcome config wiring inspection shared by the command renderers. @module */
import { maskComments, maskSourceCode } from '../devtool/sources.ts';
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
  // Identifier-aware boundaries: `\b` treats `$` as a non-word character, so it
  // neither matches before `$name` nor stops `$Name(` matching `Name(`.
  return code === undefined
    ? undefined
    : new RegExp(`(?<![\\w$])${symbol.replaceAll('$', () => '\\$')}\\s*\\(`).test(code);
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

/**
 * The local names a config gives `symbol` when importing it from
 * `@setu-ts/<pkg>`: the symbol itself plus every `symbol as alias` binding.
 * Type-only bindings and commented-out imports are skipped.
 */
export function importedCallNames(config: string, pkg: string, symbol: string): readonly string[] {
  const names = new Set([symbol]);
  const from = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]@setu-ts/${pkg}['"]`, 'g');
  // Comments are blanked so a commented-out import adds no alias; strings stay, so
  // the package specifier still matches. Unclassifiable source yields no aliases.
  for (const [, bindings = ''] of (maskComments(config) ?? '').matchAll(from)) {
    for (const binding of bindings.split(',')) {
      const [, exported, local = ''] =
        /^\s*(?!type\s)([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(binding) ?? [];
      if (exported === symbol) names.add(local);
    }
  }
  return [...names];
}

/**
 * Finds installed providers absent from this config's calls: every zero-config
 * provider, plus every provider `setu add` prints a registration for because it
 * needs options (`CONFIGURED_PROVIDERS`), which an installed package left
 * unregistered is just as likely to be.
 * Registration elsewhere can be silenced by id in the project's check config.
 * @since 0.13.0
 */
export function unregisteredPluginFindings(
  config: string,
  installed: ReadonlySet<string>,
): Finding[] {
  const starter = composingStarter(config);
  const candidates = new Map([...ZERO_CONFIG_WIRINGS, ...CONFIGURED_PROVIDERS]);
  const findings: Finding[] = [];
  // A workspace member's CLI-owned transport module registers `GrpcPlugin`, and
  // the config reaches it only through `...transportPlugins()` (M138).
  const transportModule = calledOutsideImports(config, 'transportPlugins') === true;
  // A Workers config's createApp takes `waitUntil` (or `_waitUntil`); there the
  // cache and store come from CloudflarePlugin's KV and R2 arms, never an
  // in-memory CachePlugin or StoragePlugin, which `setu add` refuses there.
  const workers = /\b_?waitUntil\??\s*:/.test(maskComments(config) ?? config);
  for (const [pkg, { symbol }] of candidates) {
    if (pkg === 'grpc-plugin' && transportModule) continue;
    if (workers && (pkg === 'cache-plugin' || pkg === 'storage-plugin')) continue;
    if (
      installed.has(pkg) &&
      !starter?.arms.has(pkg) &&
      importedCallNames(config, pkg, symbol).every(
        (name) => calledOutsideImports(config, name) === false,
      )
    ) {
      findings.push({ kind: 'plugin-unregistered', pkg, symbol });
    }
  }
  return findings;
}
