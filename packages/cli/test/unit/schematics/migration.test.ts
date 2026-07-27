/**
 * Unit tests for the migration schematic (gated on database-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateMigration } from '../../../src/schematics/migration.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateMigration', () => {
  it('emits a migration file with timestamped filename', () => {
    const names = deriveNames('add-users-table');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateMigration(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toMatch(/\/?\d+-add-users-table\.migration\.ts$/);
    expect(files[0].contents).toContain('Migration');
    expect(files[0].contents).toContain('up()');
    expect(files[0].contents).toContain('down()');
  });
});
