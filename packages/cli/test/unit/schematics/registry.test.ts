import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CUSTOM_SCHEMATIC,
  getSchematic,
  listSchematics,
} from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('schematic registry', () => {
  it('registers exactly thirteen built-in schematics', () => {
    expect(listSchematics()).toHaveLength(13);
  });

  it('names the custom pseudo-schematic', () => {
    expect(CUSTOM_SCHEMATIC).toBe('custom');
  });

  it('exposes every name as a lookup', () => {
    for (const { name } of listSchematics()) {
      expect(getSchematic(name)).toBeDefined();
    }
  });

  it('carries the gate metadata listSchematics reports', () => {
    for (const { name, requiresPlugin } of listSchematics()) {
      expect(getSchematic(name)?.requiresPlugin).toBe(requiresPlugin);
    }
  });

  it('gates exactly the eight plugin-dependent schematics', () => {
    const gated = listSchematics()
      .filter((s) => s.requiresPlugin !== undefined)
      .map((s) => s.name);
    expect(gated.sort()).toEqual([
      'command-handler',
      'controller',
      'event-handler',
      'guard',
      'health-indicator',
      'metric',
      'migration',
      'query-handler',
    ]);
  });

  it('returns undefined for an unknown name', () => {
    expect(getSchematic('nonsense')).toBeUndefined();
  });

  it('returns undefined for inherited Object properties', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(getSchematic(name)).toBeUndefined();
    }
  });

  it('every registered factory produces at least one file', () => {
    for (const { name } of listSchematics()) {
      const files = getSchematic(name)!.factory(deriveNames('order-item'), options());
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it('every registered factory emits a distinct path', () => {
    const paths = listSchematics().flatMap(({ name }) =>
      getSchematic(name)!.factory(deriveNames('order-item'), options()).map((f) => f.path)
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every registered factory emits TypeScript under src/', () => {
    for (const { name } of listSchematics()) {
      for (const file of getSchematic(name)!.factory(deriveNames('order-item'), options())) {
        expect(file.path.startsWith('src/')).toBe(true);
        expect(file.path.endsWith('.ts')).toBe(true);
      }
    }
  });
});
