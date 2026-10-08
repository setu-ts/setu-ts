/**
 * Drift gate for the CLI's health-indicator claim table (M70g — register row A1).
 *
 * `setu generate health-indicator database` refuses before writing, because
 * `DatabasePlugin` already claims that name and `HealthService.registerIndicator`
 * throws on a duplicate. The refusal reads a static table in
 * `packages/cli/src/utils/plugin-claims.ts`, because `generate` may not boot the target
 * project and a zero-dependency CLI cannot import a plugin to ask it.
 *
 * A static table drifts. This gate reads every `ctx.health.register(...)` site in the
 * package sources and fails when a name is missing from the table — and, so the gate
 * cannot pass vacuously, requires every site whose name is NOT a string literal to be
 * listed here with the default name it derives.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { PLUGIN_HEALTH_INDICATORS } from '../packages/cli/src/utils/plugin-claims.ts';

/**
 * `packages/cli` is not a plugin and holds no `IPluginContext`, so nothing in it can
 * claim an indicator name. Two files there DO contain the call text — the schematic
 * emits it in a template string, and the claim table's own JSDoc quotes the pattern
 * this gate matches — and both are prose about the call rather than the call.
 */
const NON_PLUGIN_PACKAGES = new Set(['cli']);

/** One derived registration: the expression in source and the default name it yields. */
interface DerivedSite {
  readonly expression: string;
  readonly name: string;
}

/**
 * Sites whose indicator name is an expression rather than a literal.
 *
 * Each entry names the expression as it appears in source and the DEFAULT name it
 * evaluates to, so a plugin that starts deriving its name — or a new one that does —
 * fails this gate instead of quietly leaving a hole in the refusal. A package may
 * register several derived names (M107: `messaging-plugin` registers the broker's
 * `token` and the outbox's `outboxToken`), so each package maps to a LIST.
 */
const DERIVED_SITES: ReadonlyMap<string, readonly DerivedSite[]> = new Map([
  ['cache-plugin', [{ expression: '`${token}`', name: 'cache' }]],
  ['database-plugin', [{ expression: '`${token}`', name: 'database' }]],
  ['mail-plugin', [{ expression: 'CAPABILITIES.MAIL', name: 'mail' }]],
  ['messaging-plugin', [
    { expression: 'token', name: 'messaging' },
    { expression: 'outboxToken', name: 'outbox' },
  ]],
  ['queue-plugin', [{ expression: 'token', name: 'queue' }]],
  ['secrets-plugin', [{ expression: 'CAPABILITIES.SECRETS', name: 'secrets' }]],
  ['storage-plugin', [{ expression: 'CAPABILITIES.STORAGE', name: 'storage' }]],
]);

/** Recursively lists every `.ts` file under `dir`, workspace-relative. */
async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith('.ts')) out.push(`${dir}/${entry.name}`);
    else if (entry.isDirectory) out.push(...(await listTsFiles(`${dir}/${entry.name}`)));
  }
  return out;
}

/** One registration site: the package that owns it and the name it registers. */
interface Site {
  readonly pkg: string;
  readonly file: string;
  /** The literal name, or the raw expression when the name is derived. */
  readonly argument: string;
  readonly literal: boolean;
}

/** Reads every `ctx.health.register(` site, tolerating the argument on the next line. */
function sitesIn(pkg: string, file: string, source: string): Site[] {
  const found: Site[] = [];
  for (const match of source.matchAll(/ctx\.health\.register\(\s*([^,\n)]+)/g)) {
    const raw = match[1].trim();
    const literal = raw.startsWith("'");
    found.push({ pkg, file, argument: literal ? raw.slice(1, -1) : raw, literal });
  }
  return found;
}

/**
 * The derived-site check, as a pure function of the sites and the two tables so the
 * gate's own failure path can be tested: every derived site's expression must be one
 * its package lists in `derived`, and every listed default name must be in `claims`.
 *
 * @param sites - Every registration site found
 * @param derived - Package → the derived expressions it may register
 * @param claims - The CLI claim table
 * @returns One line per problem; empty when the gate passes
 */
function checkDerivedSites(
  sites: readonly Site[],
  derived: ReadonlyMap<string, readonly DerivedSite[]>,
  claims: ReadonlyMap<string, readonly string[]>,
): string[] {
  const problems: string[] = [];
  for (const site of sites.filter((candidate) => !candidate.literal)) {
    const known = (derived.get(site.pkg) ?? []).find((d) => d.expression === site.argument);
    if (known === undefined) {
      problems.push(`${site.pkg} registers ${site.argument} (${site.file})`);
    } else if (!(claims.get(site.pkg) ?? []).includes(known.name)) {
      // Each derived site's default name must be in the table too, or the refusal
      // has a hole exactly where the most-reached-for names live (`cache`, `database`).
      problems.push(`${site.pkg} derives '${known.name}', which the claim table does not list`);
    }
  }
  return problems;
}

/** Collects every registration site across the package sources. */
async function collectSites(): Promise<Site[]> {
  const sites: Site[] = [];
  for await (const pkg of Deno.readDir('packages')) {
    if (!pkg.isDirectory || NON_PLUGIN_PACKAGES.has(pkg.name)) continue;
    const srcDir = `packages/${pkg.name}/src`;
    try {
      await Deno.stat(srcDir);
    } catch {
      continue;
    }
    for (const file of await listTsFiles(srcDir)) {
      sites.push(...sitesIn(pkg.name, file, await Deno.readTextFile(file)));
    }
  }
  return sites;
}

describe('CLI health-indicator claim table', () => {
  it('covers every literal indicator name a plugin registers', async () => {
    const missing = (await collectSites())
      .filter((site) => site.literal)
      .filter((site) => !(PLUGIN_HEALTH_INDICATORS.get(site.pkg) ?? []).includes(site.argument))
      .map((site) => `${site.pkg} registers '${site.argument}' (${site.file})`);

    expect(missing).toEqual([]);
  });

  it('accounts for every derived indicator name', async () => {
    expect(checkDerivedSites(await collectSites(), DERIVED_SITES, PLUGIN_HEALTH_INDICATORS))
      .toEqual([]);
  });

  it('the derived-site check itself fails on an unaccounted name (self-test)', () => {
    // A synthetic site list, so the gate's own failure path is proven rather than
    // assumed: a package with TWO accounted derived sites passes, and a THIRD,
    // unaccounted derived name in the same package is reported.
    const claims = new Map([['demo-plugin', ['demo', 'demo-outbox']]]);
    const derived = new Map([['demo-plugin', [
      { expression: 'token', name: 'demo' },
      { expression: 'outboxToken', name: 'demo-outbox' },
    ]]]);
    const site = (argument: string): Site => ({
      pkg: 'demo-plugin',
      file: 'packages/demo-plugin/src/plugin.ts',
      argument,
      literal: false,
    });
    expect(checkDerivedSites([site('token'), site('outboxToken')], derived, claims)).toEqual([]);
    expect(checkDerivedSites([site('token'), site('inboxToken')], derived, claims)).toEqual([
      'demo-plugin registers inboxToken (packages/demo-plugin/src/plugin.ts)',
    ]);
    // An accounted expression whose default name is missing from the claim table
    // is a hole in the refusal, reported too.
    const unclaimed = new Map([['demo-plugin', ['demo']]]);
    expect(checkDerivedSites([site('outboxToken')], derived, unclaimed)).toEqual([
      "demo-plugin derives 'demo-outbox', which the claim table does not list",
    ]);
  });

  it('lists no package that registers no indicator at all', async () => {
    const registering = new Set((await collectSites()).map((site) => site.pkg));
    const stale = [...PLUGIN_HEALTH_INDICATORS.keys()].filter((pkg) => !registering.has(pkg));

    expect(stale).toEqual([]);
  });
});
