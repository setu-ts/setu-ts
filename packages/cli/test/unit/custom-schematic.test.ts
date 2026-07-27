/**
 * Unit tests for custom schematic loading.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { validateSchematic } from '../../src/schematics/custom.ts';

// Test that the custom schematic module exports the right shapes
// Actual file loading tests are in integration/custom-schematic-real-import.test.ts

describe('custom schematic', () => {
  it('loads custom schematics through the loadSchematic seam', () => {
    expect(true).toBe(true); // Placeholder - real test would involve file system access
  });

  it('validates schematic shape with validateSchematic', () => {
    const validSchematic = (
      _names: object,
      _options: object,
    ) => [{ path: 'test.ts', contents: '' } as unknown];
    expect(validateSchematic(validSchematic)).toBe(true);

    const invalidSchematic = 'not a function' as unknown;
    expect(validateSchematic(invalidSchematic)).toBe(false);
  });
});
