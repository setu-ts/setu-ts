/**
 * The `/format` subpath is browser-safe by construction, not by assumption.
 *
 * Two checks, and the first is the one that discriminates:
 *
 * 1. STRUCTURAL — `deno info --json` lists every module the entry reaches,
 *    including type-only ones; a dependency reached through a value import
 *    carries a `code` specifier and a type-only one does not. Walking only the
 *    `code` edges gives the RUNTIME graph, which must stay inside
 *    `src/format/`. A stray value import of `@setu-ts/common` would type-check
 *    and pass check 2 (nothing in `common` touches `Deno` at module scope),
 *    so the negative control below plants exactly that and must fail here.
 * 2. BEHAVIOURAL — a subprocess deletes `globalThis.Deno` before importing
 *    the subpath and formats the same inputs. It proves import independence
 *    and same-runtime consistency, NOT cross-runtime output parity, which the
 *    plugin deliberately does not promise (ICU data and time zones differ).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { format } from '../../src/format/index.ts';

const PACKAGE_DIR = new URL('../../', import.meta.url);
const FORMAT_DIR = new URL('src/format/', PACKAGE_DIR);

interface InfoDependency {
  readonly code?: { readonly specifier: string };
}

interface InfoModule {
  readonly specifier: string;
  readonly dependencies?: readonly InfoDependency[];
}

/** The modules reachable from `entry` through VALUE imports only. */
async function runtimeGraph(entry: URL): Promise<readonly string[]> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ['info', '--json', entry.href],
    cwd: PACKAGE_DIR,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  const info = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    readonly roots: readonly string[];
    readonly modules: readonly InfoModule[];
  };
  const bySpecifier = new Map(info.modules.map((module) => [module.specifier, module]));
  const reached = new Set<string>(info.roots);
  const queue = [...info.roots];
  while (queue.length > 0) {
    const module = bySpecifier.get(queue.shift() as string);
    for (const dependency of module?.dependencies ?? []) {
      const target = dependency.code?.specifier;
      if (target !== undefined && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return [...reached].sort();
}

describe('the /format subpath runtime graph', () => {
  it('stays inside src/format/', async () => {
    const graph = await runtimeGraph(new URL('index.ts', FORMAT_DIR));
    expect(graph.map((specifier) => specifier.slice(FORMAT_DIR.href.length)).sort()).toEqual([
      'format.ts',
      'index.ts',
      'negotiate.ts',
    ]);
    expect(graph.every((specifier) => specifier.startsWith(FORMAT_DIR.href))).toBe(true);
  });

  it('negative control: a planted value import of @setu-ts/common is detected', async () => {
    const scratch = await Deno.makeTempDir({
      dir: new URL('.', PACKAGE_DIR).pathname,
      prefix: '.format-probe-',
    });
    try {
      for (const file of ['format.ts', 'index.ts', 'negotiate.ts', 'types.ts']) {
        await Deno.copyFile(new URL(file, FORMAT_DIR), `${scratch}/${file}`);
      }
      const formatFile = `${scratch}/format.ts`;
      const planted = "import { CAPABILITIES } from '@setu-ts/common';\nvoid CAPABILITIES;\n" +
        await Deno.readTextFile(formatFile);
      await Deno.writeTextFile(formatFile, planted);
      const graph = await runtimeGraph(new URL(`file://${scratch}/index.ts`));
      const outside = graph.filter((specifier) => !specifier.startsWith(`file://${scratch}/`));
      expect(outside.length).toBeGreaterThan(0);
      expect(outside.some((specifier) => specifier.includes('/common/'))).toBe(true);
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  });
});

describe('the /format subpath without the Deno namespace', () => {
  it('imports and formats identically with globalThis.Deno deleted', async () => {
    const date = new Date(0).toISOString();
    const probe = [
      'const D = globalThis.Deno;',
      'delete globalThis.Deno;',
      `const m = await import(${JSON.stringify(new URL('index.ts', FORMAT_DIR).href)});`,
      'const out = {',
      '  deno: typeof globalThis.Deno,',
      '  keys: Object.keys(m).sort(),',
      "  text: m.format('Hi {name}, {n}', { name: 'Ada', n: 1234.5 }, 'de-DE'),",
      "  plural: m.format({ one: '{count} item', other: '{count} items' }, { count: 2 }, 'en'),",
      `  date: m.format('{d}', { d: new Date(${
        JSON.stringify(date)
      }) }, 'en-GB', { timeZone: 'UTC' }),`,
      "  locale: m.negotiateLocale(m.parseAcceptLanguage('en;q=0, *').preferred, ['en', 'fr'],",
      "    m.parseAcceptLanguage('en;q=0, *').excluded),",
      '};',
      'D.stdout.writeSync(new TextEncoder().encode(JSON.stringify(out)));',
    ].join('\n');
    const output = await new Deno.Command(Deno.execPath(), {
      args: ['eval', probe],
      cwd: PACKAGE_DIR,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    expect(new TextDecoder().decode(output.stderr)).toBe('');
    const result = JSON.parse(new TextDecoder().decode(output.stdout));
    expect(result).toEqual({
      deno: 'undefined',
      keys: ['format', 'negotiateLocale', 'parseAcceptLanguage'],
      text: format('Hi {name}, {n}', { name: 'Ada', n: 1234.5 }, 'de-DE'),
      plural: '2 items',
      date: format('{d}', { d: new Date(0) }, 'en-GB', { timeZone: 'UTC' }),
      locale: 'fr',
    });
  });
});
