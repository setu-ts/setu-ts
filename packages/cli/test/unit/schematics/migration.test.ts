import { describe, expect, it } from 'vitest';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMigration } from '../../../src/schematics/migration.ts';
import { getSchematic } from '../../../src/schematics/registry.ts';
import { gateOf, options } from './_shared.ts';
import * as nodeFs from 'node:fs/promises';
import { NODE_SOURCE_ARGS, run as runProcess, tempDir } from '../../../../../test/node-helpers.ts';

describe('migration schematic', () => {
  it('documents compiled production and source development commands on Node', () => {
    const runner = generateMigration(deriveNames('initial'), {
      ...options(),
      runtime: 'node',
    }).find((file) => file.path.endsWith('/run.ts'))!.contents;
    expect(runner).toContain('node dist/src/migrations/run.js');
    expect(runner).toContain('npx tsx src/migrations/run.ts');
  });
  const files = generateMigration(deriveNames('add-orders'), options());
  const [file] = files;

  it('emits the migration, its managed barrel, and the runner', () => {
    // D5: the one schematic gated on `database-plugin` used to produce a file
    // nothing imported and nothing could run, so every project that used it
    // hand-wrote the same `src/migrations/run.ts`.
    expect(files.map((file) => file.path)).toEqual([
      'src/migrations/20260728123045-add-orders.ts',
      'src/migrations/index.ts',
      'src/migrations/run.ts',
    ]);
  });

  it('marks the barrel and runner managed, and the migration NOT', () => {
    // The migration is the developer's file; the other two are CLI-owned, and
    // that exemption is the only reason a second `generate migration` does not
    // refuse on them.
    expect(files.filter((file) => file.managed === true).map((file) => file.path)).toEqual([
      'src/migrations/index.ts',
      'src/migrations/run.ts',
    ]);
  });

  it('lists an existing migration alongside the new one, in order', () => {
    const withPrior = generateMigration(deriveNames('add-orders'), {
      ...options(),
      migrations: ['20200101000000-add-users'],
    });
    const barrel = withPrior.find((file) => file.path === 'src/migrations/index.ts');
    const body = barrel?.contents ?? '';

    expect(body).toContain("'20200101000000-add-users'");
    expect(body).toContain(
      'export const MIGRATION_NAMES: readonly string[] = MIGRATIONS.map((entry) => entry.name)',
    );
    expect(body.indexOf("'20200101000000-add-users'")).toBeLessThan(
      body.indexOf("'20260728123045-add-orders'"),
    );
  });

  it('is gated on database-plugin, then on common, which the runner imports', () => {
    const gate = getSchematic('migration')?.requiresPluginWhen;
    expect(gateOf('migration')).toBeUndefined();
    expect(gate?.(new Set())).toBe('database-plugin');
    expect(gate?.(new Set(['database-plugin']))).toBe('common');
    expect(gate?.(new Set(['database-plugin', 'common']))).toBeUndefined();
  });

  it('names the file from the INJECTED clock, not the wall clock', () => {
    // options().now() is fixed at 2026-07-28T12:30:45Z.
    expect(file.path).toBe('src/migrations/20260728123045-add-orders.ts');
  });

  it('formats the timestamp in UTC regardless of the local zone', () => {
    const [emitted] = generateMigration(deriveNames('x'), {
      runtime: 'deno',
      plugins: new Set(),
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(emitted.path).toBe('src/migrations/20260102030405-x.ts');
  });

  it('zero-pads every component to a sortable 14 characters', () => {
    const [emitted] = generateMigration(deriveNames('x'), {
      runtime: 'deno',
      plugins: new Set(),
      now: () => Date.UTC(999, 8, 9, 1, 2, 3),
    });
    expect(emitted.path).toBe('src/migrations/09990909010203-x.ts');
  });

  it('sorts chronologically by filename', () => {
    const early = generateMigration(deriveNames('a'), {
      runtime: 'deno',
      plugins: new Set(),
      now: () => Date.UTC(2026, 0, 1),
    })[0].path;
    const late = generateMigration(deriveNames('b'), {
      runtime: 'deno',
      plugins: new Set(),
      now: () => Date.UTC(2026, 11, 31),
    })[0].path;
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('declares both up and down', () => {
    expect(file.contents).toContain('async up(): Promise<void>');
    expect(file.contents).toContain('async down(): Promise<void>');
  });

  it('exports the migration under the fixed name the barrel imports', () => {
    // Named after the file, the barrel could not import it without deriving the
    // symbol from the filename — a second source of truth for the same string.
    expect(file.contents).toContain('export const migration: Migration = {');
    expect(file.contents).toContain("import type { Migration } from './run.ts';");
  });

  it('produces contents ending in a newline', () => {
    expect(file.contents.endsWith('\n')).toBe(true);
  });
});

describe('the migration runner, per target', () => {
  /** The runner a project of `runtime` gets. */
  const runnerFor = (runtime: 'deno' | 'node' | 'bun' | 'cloudflare-workers'): string => {
    const files = generateMigration(deriveNames('add-orders'), { ...options(), runtime });
    return files.find((file) => file.path === 'src/migrations/run.ts')!.contents;
  };

  it('runs as a Deno main module on Deno', () => {
    const runner = runnerFor('deno');
    expect(runner).toContain(
      '//   deno run --allow-net --allow-env --allow-read --allow-sys src/migrations/run.ts          # apply',
    );
    expect(runner).not.toContain('deno run -A');
    expect(runner).toContain('Grant the same permission flags as your `start` task');
    expect(runner).toContain('if (import.meta.main) {');
    expect(runner).toContain("Deno.args.includes('--down')");
    expect(runner).not.toContain('node:url');
    expect(runner).not.toContain('process.');
  });

  // Node gained `import.meta.main` only in 24.2 and the floor is 22, so an npm
  // target compares its own URL with the script it was asked to run. A Deno
  // global there would not even type-check.
  for (const [runtime, command] of [
    ['node', 'npx tsx src/migrations/run.ts'],
    ['bun', 'bun run src/migrations/run.ts'],
  ] as const) {
    it(`runs as the entry script on ${runtime}`, () => {
      const runner = runnerFor(runtime);
      expect(runner).toContain(`//   ${command}          # apply`);
      expect(runner).toContain("import { pathToFileURL } from 'node:url';");
      expect(runner).toContain(
        "if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {",
      );
      expect(runner).toContain("process.argv.includes('--down')");
      expect(runner).not.toContain('Deno.');
      expect(runner).not.toContain('import.meta.main');
    });
  }

  it('emits no entry block on Workers, where bindings belong to the caller', () => {
    const runner = runnerFor('cloudflare-workers');
    expect(runner).toContain('export async function runMigrations(');
    expect(runner).toContain('wrangler d1 migrations');
    expect(runner).not.toContain('if (import.meta');
    expect(runner).not.toContain('setu.config.ts');
    expect(runner).not.toContain('node:url');
    expect(runner).not.toContain('process.');
    expect(runner).not.toContain('Deno.');
  });

  it('loads the app dynamically only inside the socket target entry guard', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      const runner = runnerFor(runtime);
      expect(runner.indexOf("await import('../../setu.config.ts')")).toBeGreaterThan(
        runner.indexOf('if (import.meta'),
      );
      expect(runner).toContain('const app = await createApp();');
      expect(runner).toContain('await app.start();');
      expect(runner).toContain('finally {\n    await app.stop();');
    }
  });

  it('executes generated code: skips applied, records after success, reverses newest first and stops on failure', async () => {
    const directory = await tempDir({ prefix: 'migration-runner-' });
    try {
      await nodeFs.writeFile(`${directory}/run.ts`, runnerFor('node'));
      await nodeFs.writeFile(
        `${directory}/index.ts`,
        `
export const events: string[] = [];
export let fail = false;
export function failNext() { fail = true; }
export const MIGRATIONS = ['one', 'two', 'three'].map((name) => ({ name, migration: {
  async up(context: { database: object }) {
    if (!context.database) throw new Error('missing database');
    events.push('up ' + name);
    if (fail && name === 'two') throw new Error('driver failure');
  },
  async down() { events.push('down ' + name); },
} }));
`,
      );
      await nodeFs.writeFile(
        `${directory}/probe.ts`,
        `
import assert from 'node:assert/strict';
import { runMigrations } from './run.ts';
import { events, failNext } from './index.ts';
const names = new Set(['one']);
const ledger = {
  async applied() { return [...names]; },
  async record(name: string, at: string) {
    assert.match(at, /^\\d{4}-\\d{2}-\\d{2}T/);
    events.push('record ' + name); names.add(name);
  },
  async remove(name: string) { events.push('remove ' + name); names.delete(name); },
};
const options = { database: {}, ledger };
await runMigrations('up', options);
assert.deepEqual(events, ['up two', 'record two', 'up three', 'record three']);
events.length = 0;
await runMigrations('up', options);
assert.deepEqual(events, []);
await runMigrations('down', options);
assert.deepEqual(events, ['down three', 'remove three', 'down two', 'remove two', 'down one', 'remove one']);
events.length = 0;
await runMigrations('down', options);
assert.deepEqual(events, []);
failNext();
await assert.rejects(runMigrations('up', options), (error: Error) => {
  assert.equal(error.message, 'Migration two failed on up');
  assert.equal((error.cause as Error).message, 'driver failure');
  return true;
});
assert.deepEqual(events, ['up one', 'record one', 'up two']);
assert.deepEqual([...names], ['one']);
// A change that ran but whose ledger write failed says so, rather than
// reporting the change itself as failed (a racing runner wrote the row first).
events.length = 0;
const raced = {
  async applied() { return ['one', 'two']; },
  async record() { throw new Error('duplicate key'); },
  async remove() {},
};
await assert.rejects(runMigrations('up', { database: {}, ledger: raced }), (error: Error) => {
  assert.equal(error.message, 'Migration three ran up, but its ledger row was not updated');
  assert.equal((error.cause as Error).message, 'duplicate key');
  return true;
});
assert.deepEqual(events, ['up three']);
`,
      );
      const result = await runProcess(process.execPath, {
        args: [...NODE_SOURCE_ARGS, `${directory}/probe.ts`],
        stdout: 'piped',
        stderr: 'piped',
      });
      expect(result.code, new TextDecoder().decode(result.stderr)).toBe(0);
    } finally {
      await nodeFs.rm(directory, { recursive: true });
    }
  });
});
