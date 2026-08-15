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
    run: (argv: readonly string[]) =>
      runAddCommand(
        {
          positionals: argv.filter((entry) => !entry.startsWith('--')),
          flags: Object.fromEntries(
            argv.filter((entry) => entry.startsWith('--')).map((entry) => [entry.slice(2), true]),
          ),
        },
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
    // Otherwise `setu generate` would name a command that then refuses.
    for (
      const gate of [
        'auth',
        'health',
        'metrics',
        'cqrs',
        'events',
        'database',
        'decorator',
      ]
    ) {
      expect(addableNames()).toContain(gate);
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
    expect(h.err.join('\n')).toContain('auth');
    expect(h.read('/app/deno.json')).toBe(DENO_MANIFEST);
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
