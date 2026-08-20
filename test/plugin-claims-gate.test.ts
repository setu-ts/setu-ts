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

/**
 * Sites whose indicator name is an expression rather than a literal.
 *
 * Each entry names the expression as it appears in source and the DEFAULT name it
 * evaluates to, so a plugin that starts deriving its name — or a new one that does —
 * fails this gate instead of quietly leaving a hole in the refusal.
 */
const DERIVED_SITES: ReadonlyMap<string, { readonly expression: string; readonly name: string }> =
  new Map([
    ['cache-plugin', { expression: '`${token}`', name: 'cache' }],
    ['database-plugin', { expression: '`${token}`', name: 'database' }],
    ['mail-plugin', { expression: 'CAPABILITIES.MAIL', name: 'mail' }],
    ['messaging-plugin', { expression: 'token', name: 'messaging' }],
    ['queue-plugin', { expression: 'token', name: 'queue' }],
    ['secrets-plugin', { expression: 'CAPABILITIES.SECRETS', name: 'secrets' }],
    ['storage-plugin', { expression: 'CAPABILITIES.STORAGE', name: 'storage' }],
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
    const derived = (await collectSites()).filter((site) => !site.literal);
    const unaccounted = derived
      .filter((site) => DERIVED_SITES.get(site.pkg)?.expression !== site.argument)
      .map((site) => `${site.pkg} registers ${site.argument} (${site.file})`);

    expect(unaccounted).toEqual([]);
    // Each derived site's default name must be in the table too, or the refusal has
    // a hole exactly where the most-reached-for names live (`cache`, `database`).
    for (const site of derived) {
      const known = DERIVED_SITES.get(site.pkg)!;
      expect(PLUGIN_HEALTH_INDICATORS.get(site.pkg) ?? []).toContain(known.name);
    }
  });

  it('lists no package that registers no indicator at all', async () => {
    const registering = new Set((await collectSites()).map((site) => site.pkg));
    const stale = [...PLUGIN_HEALTH_INDICATORS.keys()].filter((pkg) => !registering.has(pkg));

    expect(stale).toEqual([]);
  });
});
