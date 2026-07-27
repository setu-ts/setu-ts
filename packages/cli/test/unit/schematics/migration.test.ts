/**
 * Unit tests for the migration schematic (gated on database-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateMigration } from '../../../src/schematics/migration.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateMigration', () => {
  it('emits a timestamped migration stub', () => {
    const names = deriveNames('create-table');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateMigration(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toMatch(/^src\/migrations\/\d+-create-table\.up\.ts$/);
    expect(files[0].contents).toContain('up');
    expect(files[0].contents).toContain('down');
  });

  it('includes the requiresPlugin metadata', () => {
    const names = deriveNames('add-index');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateMigration(names, options);

    expect(files[0].contents).toContain('Requires database-plugin');
  });
});
