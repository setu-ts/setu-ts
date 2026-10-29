import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SCHEMATIC,
  getSchematic,
  listSchematics,
} from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('schematic registry', () => {
  it('registers exactly seventeen built-in schematics', () => {
    expect(listSchematics()).toHaveLength(17);
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

  it('gates exactly the nine plugin-dependent schematics', () => {
    // A conditional gate counts when it refuses a bare project.
    const gated = listSchematics()
      .filter((s) => (s.requiresPlugin ?? s.requiresPluginWhen?.(new Set())) !== undefined)
      .map((s) => s.name);
    // `controller` left this list in M70h/E8: it is now mode-aware rather than
    // gated, so it works in a bare project.
    expect(gated.sort()).toEqual([
      'command-handler',
      'event-handler',
      'guard',
      'health-indicator',
      'metric',
      'migration',
      'query-handler',
      'schema',
      'sse',
      'ws-route',
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

  // Contract checks every schematic shares, as one table rather than a copy per schematic file:
  // a new schematic is covered by registering it.
  it('every registered factory emits non-empty files ending in a newline', () => {
    for (const { name } of listSchematics()) {
      for (const file of getSchematic(name)!.factory(deriveNames('order-item'), options())) {
        expect(file.contents.length, `${name}: ${file.path}`).toBeGreaterThan(0);
        expect(file.contents.endsWith('\n'), `${name}: ${file.path}`).toBe(true);
      }
    }
  });

  it('every registered factory derives identical output from any casing of the same name', () => {
    for (const { name } of listSchematics()) {
      const factory = getSchematic(name)!.factory;
      const kebab = factory(deriveNames('order-item'), options());
      for (const spelling of ['OrderItem', 'orderItem', 'order_item']) {
        expect(factory(deriveNames(spelling), options()), `${name}: ${spelling}`).toEqual(kebab);
      }
    }
  });

  it('every registered factory produces at least one file', () => {
    for (const { name } of listSchematics()) {
      const files = getSchematic(name)!.factory(deriveNames('order-item'), options());
      expect(files.length).toBeGreaterThan(0);
    }
  });

  // Artifact paths only. Two schematics DO share one seam barrel by design —
  // `command-handler` and `query-handler` both regenerate `src/cqrs/index.ts` from both
  // name lists — so a blanket distinctness check would fail on a deliberate property.
  // What must stay distinct is the artifact each schematic writes: two of those on one
  // path would silently clobber.
  it('every registered factory emits a distinct artifact path', () => {
    const paths = listSchematics().flatMap(({ name }) =>
      getSchematic(name)!
        .factory(deriveNames('order-item'), options())
        .filter((f) => f.managed !== true)
        .map((f) => f.path),
    );
    expect(new Set(paths).size).toBeLessThan(paths.length);
    expect(paths.filter((path) => path === 'src/controllers/order-item.routes.ts')).toHaveLength(1);
  });

  it('shares seam barrels only where the generated artifacts share a family', () => {
    const barrels = new Map<string, string[]>();
    for (const { name } of listSchematics()) {
      for (const file of getSchematic(name)!.factory(deriveNames('order-item'), options())) {
        if (file.managed !== true) continue;
        barrels.set(file.path, [...(barrels.get(file.path) ?? []), name]);
      }
    }
    const shared = [...barrels].filter(([, owners]) => owners.length > 1);
    // `controller` joined the HTTP barrel in M70h/E8 — one directory, one
    // barrel, three kinds sharing it.
    expect(shared.map(([path, owners]) => [path, owners.sort()])).toEqual([
      ['src/plugins/index.ts', ['plugin', 'ws-route']],
      ['src/controllers/index.ts', ['controller', 'route', 'sse']],
      ['src/cqrs/index.ts', ['command-handler', 'query-handler']],
    ]);
  });

  it('every registered factory emits TypeScript under src/', () => {
    for (const { name } of listSchematics()) {
      for (const file of getSchematic(name)!.factory(deriveNames('order-item'), options())) {
        expect(file.path.startsWith('src/') || file.path === 'test/support/server.ts').toBe(true);
        expect(file.path.endsWith('.ts')).toBe(true);
      }
    }
  });
});
