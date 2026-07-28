import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMigration } from '../../../src/schematics/migration.ts';
import { gateOf, options } from './_shared.ts';

describe('migration schematic', () => {
  const files = generateMigration(deriveNames('add-orders'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
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

  it('exports the migration under a camelCase name', () => {
    expect(file.contents).toContain('export const addOrdersMigration: Migration');
  });

  it('produces contents ending in a newline', () => {
    expect(file.contents.endsWith('\n')).toBe(true);
  });
});
