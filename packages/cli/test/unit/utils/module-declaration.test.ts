import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { withModuleDeclarationEntry } from '../../../src/utils/module-declaration.ts';

const DECLARATION = [
  "import { Module } from '@setu-ts/decorator-plugin';",
  '',
  "import { ShipmentController } from './shipment.controller.ts';",
  "import { ShipmentService } from './shipment.service.ts';",
  '',
  '/** Lists controllers: [NotThis] in prose, which the editor must not read. */',
  '@Module({',
  '  controllers: [ShipmentController],',
  '  providers: [ShipmentService],',
  '})',
  'export class ShipmentModule {}',
  '',
].join('\n');

function edited(
  source: string,
  property: 'controllers' | 'providers',
  symbol: string,
  specifier: string,
): string {
  const result = withModuleDeclarationEntry(source, property, symbol, specifier);
  if (result.kind !== 'edited') throw new Error(`expected an edit, got ${result.kind}`);
  expect(
    ts.transpileModule(result.source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    }).diagnostics,
  ).toEqual([]);
  return result.source;
}

describe('withModuleDeclarationEntry', () => {
  it('appends to a literal array and imports after the last import', () => {
    for (const [property, symbol, file] of [
      ['controllers', 'TrackingController', 'tracking.controller.ts'],
      ['providers', 'RatesService', 'rates.service.ts'],
    ] as const) {
      expect(edited(DECLARATION, property, symbol, `./${file}`)).toBe(
        DECLARATION.replace(
          "import { ShipmentService } from './shipment.service.ts';",
          `import { ShipmentService } from './shipment.service.ts';\nimport { ${symbol} } from './${file}';`,
        ).replace(
          property === 'controllers' ? '[ShipmentController]' : '[ShipmentService]',
          property === 'controllers'
            ? `[ShipmentController, ${symbol}]`
            : `[ShipmentService, ${symbol}]`,
        ),
      );
    }
  });

  it('fills an empty array and keeps a trailing comma', () => {
    expect(
      edited(DECLARATION.replace('[ShipmentService]', '[]'), 'providers', 'A', './a.ts'),
    ).toContain('  providers: [A],\n');
    expect(
      edited(
        DECLARATION.replace('[ShipmentController]', '[\n    ShipmentController,\n  ]'),
        'controllers',
        'B',
        './b.ts',
      ),
    ).toContain('  controllers: [\n    ShipmentController, B,\n  ],\n');
  });

  it('adds a missing property as the first one', () => {
    const source = DECLARATION.replace('  controllers: [ShipmentController],\n', '');
    expect(edited(source, 'controllers', 'C', './c.ts')).toContain(
      '@Module({\n  controllers: [C],\n  providers: [ShipmentService],\n})',
    );
  });

  it('puts the import first in a file without imports', () => {
    expect(edited('@Module({})\nexport class M {}\n', 'controllers', 'D', './d.ts')).toBe(
      "import { D } from './d.ts';\n\n@Module({\n  controllers: [D],})\nexport class M {}\n",
    );
  });

  it('reports a class already listed without changing anything', () => {
    expect(
      withModuleDeclarationEntry(DECLARATION, 'controllers', 'ShipmentController', './x.ts'),
    ).toEqual({ kind: 'present' });
  });

  it('leaves every shape it cannot read exactly unchanged', () => {
    const unreadable: readonly (readonly [string, string])[] = [
      ['no declaration', 'export class M {}\n'],
      ['two declarations', `${DECLARATION}@Module({})\nexport class Other {}\n`],
      ['a non-object argument', DECLARATION.replace('@Module({', '@Module(OPTIONS, {')],
      ['an unbalanced object', '@Module({ controllers: [A]\nexport class M {}\n'],
      [
        'a shorthand property',
        DECLARATION.replace('controllers: [ShipmentController],', 'controllers,'),
      ],
      ['a quoted key', DECLARATION.replace('  controllers: [', "  'controllers': [")],
      ['a spread in the object', DECLARATION.replace('  providers:', '  ...BASE,\n  providers:')],
      ['a spread in the array', DECLARATION.replace('[ShipmentController]', '[...BASE]')],
      ['a call in the array', DECLARATION.replace('[ShipmentController]', '[make()]')],
      ['a non-array value', DECLARATION.replace('[ShipmentController]', 'BASE')],
      ['a value after the array', DECLARATION.replace('[ShipmentController]', '[A].concat(B)')],
      ['an unbalanced array', '@Module({ controllers: [A }) export class M {}\n'],
      [
        'a duplicated property',
        DECLARATION.replace('  providers:', '  controllers: [],\n  providers:'),
      ],
      ['a template literal', `const t = \`x\`;\n${DECLARATION}`],
      [
        'the class already bound elsewhere',
        DECLARATION.replace('export class', 'const TrackingController = 1;\nexport class'),
      ],
      [
        'a last import split across lines',
        DECLARATION.replace(
          "import { ShipmentService } from './shipment.service.ts';",
          "import { ShipmentService } from\n  './shipment.service.ts';",
        ),
      ],
    ];
    for (const [label, source] of unreadable)
      expect(
        withModuleDeclarationEntry(source, 'controllers', 'TrackingController', './t.ts'),
        label,
      ).toEqual({ kind: 'unreadable' });
  });
});
