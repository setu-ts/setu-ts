/**
 * The seam registry is the milestone's contract: which families reach a registration
 * site, and — just as load-bearing — which do not.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { listSeamSpecs } from '../../../src/seams/registry.ts';
import { getSchematic, listSchematics } from '../../../src/schematics/registry.ts';
import { seamSpecFor } from '../schematics/_shared.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import {
  assembleSeamBarrel,
  exportsSymbol,
  renderExportedArray,
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
      expect(seamSpecFor(schematic)).toBeUndefined();
    }
  });

  it('leaves the unwired schematics out of the seam registry', () => {
    // None of the three has a FRAMEWORK registration site, which is what this
    // registry describes. `migration` emits a project-local runner and barrel of
    // its own since D5 — that is not a seam: nothing in `setu.config.ts` imports
    // it, and no plugin option consumes it.
    const wired = new Set(listSeamSpecs().map((spec) => spec.schematic));
    for (const schematic of UNWIRED) {
      expect(wired.has(schematic)).toBe(false);
    }
  });

  it('keeps guard and job emitting a single unmanaged file', () => {
    for (const schematic of ['guard', 'job'] as const) {
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
    const spec = seamSpecFor('route')!;
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

  it('renders an inline declaration until it would run long, then breaks it', () => {
    expect(renderExportedArray('X', 'Constructor', []))
      .toBe('export const X: readonly Constructor[] = [];');
    expect(renderExportedArray('X', 'Constructor', ['A', 'B']))
      .toBe('export const X: readonly Constructor[] = [A, B];');

    const long = ['A'.repeat(40), 'B'.repeat(40)];
    expect(renderExportedArray('X', 'Constructor', long)).toContain('\n  ');
  });

  // The defect this shape exists to prevent. The renderer used to take a
  // `prefixWidth` NUMBER defaulting to 24, so every caller had to remember to
  // pass its own declaration's length and six of eight did not — measured, three
  // generated plugins produced a 123-column line and the project failed its own
  // `deno fmt --check`. Deriving the prefix from the name and type it is already
  // given makes that unrepresentable.
  it('measures the real declaration, not a guess, when deciding to wrap', () => {
    // Chosen so the two declarations land on OPPOSITE sides of the budget:
    // 105 columns for the long name, 83 for the short one. A fixed prefix width
    // cannot tell them apart, which is the whole point.
    const entries = ['OrderArchive()', 'PaymentGateway()', 'UserDirectory()'];

    // Same entries, two declarations of very different width: the long one must
    // wrap and the short one must not, which a fixed budget cannot express.
    const wide = renderExportedArray('GENERATED_PLUGINS', 'IPlugin', entries);
    const narrow = renderExportedArray('P', 'X', entries);

    expect(wide).toContain('\n  ');
    expect(narrow).not.toContain('\n  ');
    for (const line of wide.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  // The other half of the same budget: an artifact exporting two or three
  // symbols emitted a 103-112-column import line, which `deno fmt` rewraps.
  it('wraps a long import statement the way deno fmt would', () => {
    const wrapped = renderSeamImports(
      ['payment-gateway'],
      (n) => [`${n.camel}Handler`, `${n.camel}Registration`, `${n.camel}Descriptor`],
      (k) => `./${k}.command-handler.ts`,
    );

    for (const line of wrapped.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
    expect(wrapped).toContain('import {\n');
  });

  it('renders no imports for an empty family', () => {
    expect(renderSeamImports([], (n) => [n.pascal], (k) => `./${k}.ts`)).toBe('');
  });

  it('renders one import per name, in the order given', () => {
    expect(
      renderSeamImports(['order-item', 'user'], (n) => [`${n.pascal}X`], (k) => `./${k}.ts`),
    ).toBe(
      `import { OrderItemX } from './order-item.ts';\nimport { UserX } from './user.ts';`,
    );
  });

  it('names every symbol a spec declares on one import', () => {
    // The multi-symbol families (middleware, cqrs, events) depend on this, and it is the
    // same list the scanner requires the file to export.
    expect(
      renderSeamImports(['user'], (n) => [`${n.screaming}_A`, `${n.camel}B`], (k) => `./${k}.ts`),
    ).toBe(`import { USER_A, userB } from './user.ts';`);
  });
});

describe('exportsSymbol', () => {
  it('recognizes every declaration form the CLI emits', () => {
    for (
      const source of [
        'export const X = 1;',
        'export function X() {}',
        'export class X {}',
        'export interface X {}',
        'export type X = 1;',
        'export async function X() {}',
        'export declare const X: number;',
        'export abstract class X {}',
      ]
    ) {
      expect(exportsSymbol(source, 'X')).toBe(true);
    }
  });

  it('recognizes the named-re-export form, aliased or not', () => {
    expect(exportsSymbol('export { X };', 'X')).toBe(true);
    expect(exportsSymbol('export { impl as X };', 'X')).toBe(true);
    expect(exportsSymbol('export {\n  a,\n  X,\n};', 'X')).toBe(true);
  });

  it('does not mistake a mention for an export', () => {
    // A false positive would put an unresolvable import in the developer's barrel, so
    // every one of these must read as absent.
    for (
      const source of [
        '// X is documented here',
        'X();',
        'const X = 1;',
        'import { X } from "./other.ts";',
        'export const XY = 1;',
        'export const YX = 1;',
      ]
    ) {
      expect(exportsSymbol(source, 'X')).toBe(false);
    }
  });

  it('is not confused by a similarly-named sibling export', () => {
    expect(exportsSymbol('export const ORDERS_TOTAL = 1;', 'ORDERS_METRIC')).toBe(false);
    expect(exportsSymbol('export const ORDERS_TOTAL = 1;', 'ORDERS_TOTAL')).toBe(true);
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
