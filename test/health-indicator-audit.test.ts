/**
 * M70c health-indicator audit gate (plan §3.9).
 *
 * `docs/health-indicators.md` classifies every `ctx.health.register(...)` site in
 * the package source trees as `live-state`, `justified-literal`, or `configuration-literal`.
 * This test scans the source tree for registration sites and asserts each one
 * appears in the document, so a new (or moved) indicator cannot be added
 * unclassified. The CLI schematic's mention of `ctx.health.register` is a
 * template string, not a site, and is excluded per the plan.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const ROOT = new URL('..', import.meta.url);
const DOCS = new URL('docs/health-indicators.md', ROOT);

/** The CLI schematic documents the call in a template string; it is not a site. */
const EXCLUDED = new Set(['packages/cli/src/schematics/health-indicator.ts']);

/** Recursively lists every `.ts` file under `dir`, workspace-relative. */
async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) {
      if (entry.name.endsWith('.ts')) {
        out.push(`${dir}/${entry.name}`);
      }
      continue;
    }
    if (entry.isDirectory) {
      out.push(...(await listTsFiles(`${dir}/${entry.name}`)));
    }
  }
  return out;
}

/** Finds every `ctx.health.register(` line in a file, 1-based. */
function registrationLines(source: string): number[] {
  const lines: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (line.includes('ctx.health.register(')) {
      lines.push(i + 1);
    }
  });
  return lines;
}

describe('health-indicator audit (M70c §3.9)', () => {
  it('every ctx.health.register site is classified in docs/health-indicators.md', async () => {
    const doc = await Deno.readTextFile(DOCS);
    const sites: string[] = [];

    for await (const pkg of Deno.readDir('packages')) {
      if (!pkg.isDirectory) continue;
      const srcDir = `packages/${pkg.name}/src`;
      let exists = true;
      try {
        await Deno.stat(srcDir);
      } catch {
        exists = false;
      }
      if (!exists) continue;

      for (const file of await listTsFiles(srcDir)) {
        if (EXCLUDED.has(file)) continue;
        const source = await Deno.readTextFile(file);
        for (const line of registrationLines(source)) {
          sites.push(`${file}:${line}`);
        }
      }
    }

    expect(sites.length).toBeGreaterThan(0);

    const missing = sites.filter((site) => !doc.includes(site));
    expect(
      missing,
      `Unregistered health-indicator site(s) not present in docs/health-indicators.md — add a row:\n  ${
        missing.join('\n  ')
      }`,
    ).toEqual([]);
  });
});
