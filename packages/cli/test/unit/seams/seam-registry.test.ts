/**
 * The seam registry is the milestone's contract: which families reach a registration
 * site, and — just as load-bearing — which do not.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { getSeamSpec, listSeamSpecs } from '../../../src/seams/registry.ts';
import { getSchematic, listSchematics } from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import {
  assembleSeamBarrel,
  renderList,
  renderSeamImports,
  seamHeader,
  seamNames,
} from '../../../src/seams/seam-spec.ts';

/** The three artifacts with no registration site, and why each has none. */
const UNWIRED = ['guard', 'job', 'migration'] as const;

describe('seam registry', () => {
  it('declares a seam for exactly the ten wired families', () => {
    expect(listSeamSpecs().map((spec) => spec.schematic).sort()).toEqual([
      'command-handler',
      'controller',
      'event-handler',
      'health-indicator',
      'metric',
      'middleware',
      'plugin',
      'query-handler',
      'route',
      'service',
    ]);
  });

  // Not an omission — the milestone's finding. A guard's positions are all per target
  // and a global one would 401 /health; a job is transport-ambiguous by design; and no
  // plugin in this repository calls `ctx.cli.register`, so no migration runner exists.
  it('declares no seam for guard, job or migration', () => {
    for (const schematic of UNWIRED) {
      expect(getSeamSpec(schematic)).toBeUndefined();
    }
  });

  it('leaves the unwired schematics emitting one file and no managed barrel', () => {
    for (const schematic of UNWIRED) {
      const files = getSchematic(schematic)!.factory(deriveNames('order-item'), {
        runtime: 'deno',
        plugins: new Set(['decorator-plugin']),
        now: () => 0,
      });
      expect(files).toHaveLength(1);
      expect(files.some((f) => f.managed === true)).toBe(false);
    }
  });

  it('names a registered schematic for every seam', () => {
    const registered = new Set(listSchematics().map(({ name }) => name));
    for (const spec of listSeamSpecs()) {
      expect(registered.has(spec.schematic)).toBe(true);
    }
  });

  // The scanner matches `dir` + `suffix` against what the schematic actually writes, so
  // a mismatch means the barrel silently never lists anything.
  it('declares a dir and suffix matching the path its schematic writes', () => {
    for (const spec of listSeamSpecs()) {
      const files = getSchematic(spec.schematic)!.factory(deriveNames('order-item'), {
        runtime: 'deno',
        plugins: new Set(['decorator-plugin']),
        now: () => 0,
      });
      const artifact = files.find((f) => f.managed !== true)!;
      expect(artifact.path).toBe(`${spec.dir}/order-item${spec.suffix}`);
    }
  });

  it('declares a barrel inside its own directory', () => {
    for (const spec of listSeamSpecs()) {
      expect(spec.barrel).toBe(`${spec.dir}/index.ts`);
    }
  });

  // Every export the spec promises must exist even before anything is generated,
  // because the templates emit the barrel AND the config's import of it at scaffold
  // time — a missing export would break a fresh project's compile.
  it('renders an empty barrel that still declares every export it promises', () => {
    for (const spec of listSeamSpecs()) {
      const empty = spec.renderBarrel({});
      for (const symbol of spec.exports) {
        // `const` for the nine array barrels, `function` for the route one.
        expect(
          empty.includes(`export const ${symbol}`) || empty.includes(`export function ${symbol}`),
        ).toBe(true);
      }
      expect(empty.endsWith('\n')).toBe(true);
    }
  });

  it('renders a route barrel whose export is a function, not a constant', () => {
    // The one seam whose registration site is a CALL rather than a plugin option, so its
    // barrel is shaped differently from the other nine.
    const spec = getSeamSpec('route')!;
    expect(spec.renderBarrel({})).toContain('export function registerGeneratedRoutes');
  });
});

describe('seam rendering helpers', () => {
  it('sorts and deduplicates names, and appends the one being generated', () => {
    expect(seamNames({ route: ['user', 'billing'] }, 'route', 'admin')).toEqual([
      'admin',
      'billing',
      'user',
    ]);
  });

  it('lists a name already scanned exactly once', () => {
    expect(seamNames({ route: ['user'] }, 'route', 'user')).toEqual(['user']);
  });

  it('treats an absent family and absent artifacts alike', () => {
    expect(seamNames({}, 'route')).toEqual([]);
    expect(seamNames(undefined, 'route')).toEqual([]);
  });

  it('renders an inline list until it would run long, then breaks it', () => {
    expect(renderList([])).toBe('');
    expect(renderList(['A', 'B'])).toBe('A, B');
    const long = ['A'.repeat(40), 'B'.repeat(40)];
    expect(renderList(long)).toContain('\n  ');
  });

  it('renders no imports for an empty family', () => {
    expect(renderSeamImports([], (n) => n.pascal, (k) => `./${k}.ts`)).toBe('');
  });

  it('renders one import per name, in the order given', () => {
    expect(
      renderSeamImports(['order-item', 'user'], (n) => `${n.pascal}X`, (k) => `./${k}.ts`),
    ).toBe(
      `import { OrderItemX } from './order-item.ts';\nimport { UserX } from './user.ts';`,
    );
  });

  it('puts the command on its own header line, so a long one cannot overflow', () => {
    const header = seamHeader('setu generate command-handler / query-handler', ['X()']);
    for (const line of header.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
    expect(header).toContain('//   X()');
    expect(header).toContain('The CLI owns this file');
  });

  it('omits the import block entirely when a family is empty', () => {
    const assembled = assembleSeamBarrel('// h\n', '', ['export const X = 1;']);
    expect(assembled).toBe('// h\n\nexport const X = 1;\n');
  });
});
