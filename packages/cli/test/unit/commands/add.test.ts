/**
 * Tests for `setu add <plugin>` (D3).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import {
  addableNames,
  resolveAddablePackage,
  runAddCommand,
  withDependency,
} from '../../../src/commands/add.ts';
import { VERSION } from '../../../src/constants.ts';
import { parseArgs } from '../../../src/args.ts';
import { listSchematics } from '../../../src/schematics/registry.ts';

/** Builds a command harness over a fake filesystem. */
function harness(files: Readonly<Record<string, string>> = {}) {
  const fs = createFakeFs(files);
  const out: string[] = [];
  const err: string[] = [];
  return {
    fs,
    out,
    err,
    read: (path: string) => fs.read(path),
    // Parsed by the REAL `parseArgs`, not by a local reimplementation. The
    // hand-rolled one turned every flag into boolean `true`, so `--dir <path>` —
    // which `VALUE_FLAGS` resolves to a STRING — was never exercised, and
    // reading the wrong flag name would have passed all twelve tests.
    run: (argv: readonly string[]) =>
      runAddCommand(
        parseArgs(argv),
        { fs, cwd: '/app', log: (m) => out.push(m), error: (m) => err.push(m) },
      ),
  };
}

const DENO_MANIFEST = JSON.stringify(
  {
    tasks: { start: 'deno run main.ts' },
    imports: { '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^1' },
  },
  null,
  2,
);

describe('resolveAddablePackage', () => {
  it('accepts a short name', () => {
    expect(resolveAddablePackage('auth')).toBe('auth-plugin');
  });

  it('accepts the full specifier, so both spellings are one command', () => {
    expect(resolveAddablePackage('@setu-ts/auth-plugin')).toBe('auth-plugin');
  });

  it('accepts the bare package name', () => {
    expect(resolveAddablePackage('auth-plugin')).toBe('auth-plugin');
  });

  it('refuses a name it does not know', () => {
    // The range this writes is the CLI's OWN version, which is only correct for
    // packages released as one version with it — so a typo has to be refused
    // rather than pinned to a version that does not exist.
    expect(resolveAddablePackage('authh')).toBeUndefined();
    expect(resolveAddablePackage('@setu-ts/express')).toBeUndefined();
  });

  it('covers every gate a schematic can declare', () => {
    // DERIVED from the registry, not a hand-written list. The list version had
    // already gone stale — it still named `decorator`, which stopped being a
    // gate on this branch — and it could not have noticed a NEWLY gated
    // schematic whose plugin is missing here, which is the failure it exists to
    // prevent: `setu generate` would name a command that then refuses.
    const gates = listSchematics()
      .map(({ requiresPlugin }) => requiresPlugin)
      .filter((plugin): plugin is string => plugin !== undefined);

    expect(gates.length, 'no gated schematics — this check would be vacuous')
      .toBeGreaterThan(0);
    for (const plugin of gates) {
      expect(resolveAddablePackage(plugin), plugin).toBe(plugin);
    }
  });
});

describe('withDependency', () => {
  it('adds the entry and keeps the rest of the manifest', () => {
    const updated = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    const parsed = JSON.parse(updated ?? '') as {
      tasks: Record<string, string>;
      imports: Record<string, string>;
    };

    expect(parsed.imports['@setu-ts/auth-plugin']).toBe('jsr:x@^1');
    expect(parsed.imports['@setu-ts/kernel']).toBe('jsr:@setu-ts/kernel@^1');
    expect(parsed.tasks['start']).toBe('deno run main.ts');
  });

  it('sorts the map, so a later regeneration does not reorder the file', () => {
    const updated = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/audit-plugin', 'jsr:x@^1');
    const keys = Object.keys(
      (JSON.parse(updated ?? '') as { imports: Record<string, string> }).imports,
    );
    expect(keys).toEqual([...keys].sort());
  });

  it('reports no change when the entry is already present with that value', () => {
    const once = withDependency(DENO_MANIFEST, 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    expect(withDependency(once ?? '', 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1'))
      .toBeUndefined();
  });

  it('creates the section when the manifest has none', () => {
    const updated = withDependency('{}', 'imports', '@setu-ts/auth-plugin', 'jsr:x@^1');
    expect(JSON.parse(updated ?? '')).toEqual({ imports: { '@setu-ts/auth-plugin': 'jsr:x@^1' } });
  });
});

describe('runAddCommand', () => {
  it('pins the package at the CLI own version', async () => {
    // The rule `setu new` already follows, so a project's framework packages
    // stay on one version rather than drifting per install.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['auth'])).toBe(0);

    const parsed = JSON.parse(h.read('/app/deno.json')) as { imports: Record<string, string> };
    expect(parsed.imports['@setu-ts/auth-plugin']).toBe(`jsr:@setu-ts/auth-plugin@^${VERSION}`);
  });

  it('reports the install command rather than running it', async () => {
    // On release day `deno install` hits the 24-hour minimum-dependency-age
    // policy, so the developer needs to SEE the flags rather than watch an
    // opaque subprocess fail (D1).
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    await h.run(['auth']);

    expect(h.out.join('\n')).toContain('deno install --min-dep-age 0');
  });

  it('updates BOTH manifests when a project carries both', async () => {
    // A Workers or Node project has a `package.json` for its toolchain AND a
    // `deno.json` that `setu generate` reads for gating — writing only one
    // would leave the gate and the build disagreeing.
    const h = harness({
      '/app/deno.json': DENO_MANIFEST,
      '/app/package.json': JSON.stringify({ name: 'edge', dependencies: {} }, null, 2),
    });
    expect(await h.run(['auth'])).toBe(0);

    expect(JSON.parse(h.read('/app/deno.json')).imports['@setu-ts/auth-plugin']).toBeDefined();
    expect(JSON.parse(h.read('/app/package.json')).dependencies['@setu-ts/auth-plugin'])
      .toBe(`npm:@jsr/setu-ts__auth-plugin@^${VERSION}`);
  });

  it('is idempotent', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    await h.run(['auth']);
    const afterFirst = h.read('/app/deno.json');

    expect(await h.run(['auth'])).toBe(0);
    expect(h.read('/app/deno.json')).toBe(afterFirst);
    expect(h.out.join('\n')).toContain('already installed');
  });

  it('writes nothing under --dry-run', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['auth', '--dry-run'])).toBe(0);

    expect(h.read('/app/deno.json')).toBe(DENO_MANIFEST);
    expect(h.out.join('\n')).toContain('would update');
  });

  it('refuses an unknown name and lists what it accepts', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run(['authh'])).toBe(2);

    expect(h.err.join('\n')).toContain('not a Setu-TS package');
    // The listing, specifically. Asserting `'auth'` was vacuous: the refusal
    // echoes the rejected name, and `"authh"` contains it — so deleting the
    // Available line entirely left this test green.
    expect(h.err.join('\n')).toContain(`Available: ${addableNames().join(', ')}`);
    expect(h.read('/app/deno.json')).toBe(DENO_MANIFEST);
  });

  it('honours --dir, resolving a relative path against the working directory', async () => {
    // The harness used to reduce every flag to boolean `true`, so this path was
    // never taken and `stringFlag(args.flags, 'dir')` could have named any key
    // at all. Driven through the real parser, both spellings must work.
    const h = harness({ '/app/services/orders/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth', '--dir', 'services/orders'])).toBe(0);
    expect(JSON.parse(h.read('/app/services/orders/deno.json')).imports['@setu-ts/auth-plugin'])
      .toBeDefined();
  });

  it('accepts --dir=<path> as well as --dir <path>', async () => {
    const h = harness({ '/app/services/orders/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth', '--dir=services/orders'])).toBe(0);
    expect(JSON.parse(h.read('/app/services/orders/deno.json')).imports['@setu-ts/auth-plugin'])
      .toBeDefined();
  });

  it('refuses a directory that is not a project', async () => {
    const h = harness();
    expect(await h.run(['auth'])).toBe(1);
    expect(h.err.join('\n')).toContain('not a Setu-TS project');
  });

  it('refuses a manifest it cannot parse, naming the file', async () => {
    const h = harness({ '/app/deno.json': '{ not json' });
    expect(await h.run(['auth'])).toBe(1);
    expect(h.err.join('\n')).toContain('as JSON');
  });

  it('returns a usage error with no package named', async () => {
    const h = harness({ '/app/deno.json': DENO_MANIFEST });
    expect(await h.run([])).toBe(2);
  });

  it('lists every addable package under --help', async () => {
    const h = harness();
    expect(await h.run(['--help'])).toBe(0);
    for (const name of addableNames()) {
      expect(h.out.join('\n')).toContain(name);
    }
  });
});

describe('setu add — permission notes (X8-9)', () => {
  it('should tell a storage installer that the local provider needs --allow-write', async () => {
    // X8-9: with `STORAGE_PROVIDER=local`, an otherwise untouched scaffolded
    // project answered every upload with a parse failure while `/health` said
    // `up`, because the generated `start` task requests `--allow-read` and not
    // `--allow-write`. The provider now refuses to connect with the flag named;
    // this is the earlier of the two signals.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['storage'])).toBe(0);

    const output = h.out.join('\n');
    expect(output).toContain('--allow-write');
    expect(output).toContain("'local' provider");
  });

  it('should say nothing about permissions for a package that needs none', async () => {
    // The note must not become boilerplate printed after every add, or it stops
    // being read.
    const h = harness({ '/app/deno.json': DENO_MANIFEST });

    expect(await h.run(['auth'])).toBe(0);

    expect(h.out.join('\n')).not.toContain('--allow-write');
  });
});
