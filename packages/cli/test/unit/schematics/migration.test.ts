import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMigration } from '../../../src/schematics/migration.ts';
import { gateOf, options } from './_shared.ts';

describe('migration schematic', () => {
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
    const withPrior = generateMigration(
      deriveNames('add-orders'),
      { ...options(), migrations: ['20200101000000-add-users'] },
    );
    const barrel = withPrior.find((file) => file.path === 'src/migrations/index.ts');
    const body = barrel?.contents ?? '';

    expect(body).toContain("'20200101000000-add-users'");
    expect(body.indexOf("'20200101000000-add-users'")).toBeLessThan(
      body.indexOf("'20260728123045-add-orders'"),
    );
  });

  it('is gated on database-plugin', () => {
    expect(gateOf('migration')).toBe('database-plugin');
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
