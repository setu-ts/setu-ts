/**
 * `setu.E017` page-kernel-value-import (M130 §3.7). The accepted and refused
 * shapes are a data table, so the module comment cannot claim a set the scanner
 * does not implement.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  kernelTarget,
  scanPageImports,
  scanPageSource,
  type PageImportReason,
} from '../../../src/diagnostics/page-imports.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

const PAGE = 'app/routes/_app/products._index.tsx';

/** Shapes a page may write: nothing is reported. */
const ACCEPTED: readonly (readonly [label: string, source: string])[] = [
  ['type import', "import type { Product } from '~kernel/modules/products/products.types.ts';"],
  ['export type', "export type { Product } from '~kernel/modules/products/products.types.ts';"],
  ['token module', "import { PRODUCTS } from '~kernel/modules/products/products.token.ts';"],
  ['page alias', "import { Card } from '~/components/ui/card.tsx';"],
  ['framework package', "import { getService } from '@setu-ts/react-router-plugin';"],
  ['relative inside app', "import { requireUser } from '../../server/require-user.server.ts';"],
  [
    'multi-line type import',
    "import type {\n  Product,\n  ProductInput,\n} from '~kernel/modules/products/products.types.ts';",
  ],
  ['a comment naming the kernel', "// import { x } from '~kernel/modules/a/a.service.ts';"],
  ['a block comment', "/* import { x } from '~kernel/modules/a/a.service.ts'; */"],
  ['a string that is not a specifier', 'const hint = "from \'~kernel/modules/a/a.service.ts\'";'],
  [
    'JSX text with an apostrophe beside a type import',
    "import type { A } from '~kernel/modules/a/a.types.ts';\nexport default function P() {\n  return <p>It's here — don't worry</p>;\n}",
  ],
];

/** Shapes a page may not write, with the reason and line each is reported on. */
const REFUSED: readonly (readonly [
  label: string,
  source: string,
  reason: PageImportReason,
  line: number,
  specifier: string,
])[] = [
  [
    'value import of a service',
    "import { productsService } from '~kernel/modules/products/products.service.ts';",
    'value-import',
    1,
    '~kernel/modules/products/products.service.ts',
  ],
  [
    'inline all-type braces',
    "import { type Product } from '~kernel/modules/products/products.types.ts';",
    'inline-type-only',
    1,
    '~kernel/modules/products/products.types.ts',
  ],
  [
    'mixed default and type binding',
    "import x, { type Y } from '~kernel/modules/products/products.service.ts';",
    'value-import',
    1,
    '~kernel/modules/products/products.service.ts',
  ],
  [
    'export star, token module included',
    "export * from '~kernel/modules/products/products.token.ts';",
    'export-star',
    1,
    '~kernel/modules/products/products.token.ts',
  ],
  [
    'dynamic import',
    "const mod = await import('~kernel/modules/products/products.service.ts');",
    'dynamic',
    1,
    '~kernel/modules/products/products.service.ts',
  ],
  [
    'relative path into src/',
    "import { productsService } from '../../../src/modules/products/products.service.ts';",
    'value-import',
    1,
    '../../../src/modules/products/products.service.ts',
  ],
  [
    'side-effect import',
    "import '~kernel/modules/products/products.service.ts';",
    'value-import',
    1,
    '~kernel/modules/products/products.service.ts',
  ],
  [
    'value import in a TSX page with JSX text',
    "import type { A } from '~kernel/modules/a/a.types.ts';\nimport { aService } from '~kernel/modules/a/a.service.ts';\nexport default function P() {\n  return <p>It's {String(aService)}</p>;\n}",
    'value-import',
    2,
    '~kernel/modules/a/a.service.ts',
  ],
  [
    'value import on a later line, after a comment',
    "// header\nimport type { A } from '~kernel/modules/a/a.types.ts';\n\nimport {\n  aService,\n} from '~kernel/modules/a/a.service.ts';",
    'value-import',
    6,
    '~kernel/modules/a/a.service.ts',
  ],
];

describe('scanPageSource', () => {
  for (const [label, source] of ACCEPTED)
    it(`accepts ${label}`, async () => {
      expect(await scanPageSource(PAGE, source)).toEqual([]);
    });

  for (const [label, source, reason, line, specifier] of REFUSED)
    it(`refuses ${label}`, async () => {
      expect(await scanPageSource(PAGE, source)).toEqual([{ path: PAGE, line, specifier, reason }]);
    });

  it('reports a file it cannot parse instead of passing it', async () => {
    expect(await scanPageSource(PAGE, "import { x } from '~kernel/a.ts")).toBe('unreadable');
  });
});

describe('kernelTarget', () => {
  it.each([
    ['~kernel/modules/a/a.ts', 'src/modules/a/a.ts'],
    ['../../../src/modules/a/a.ts', 'src/modules/a/a.ts'],
    ['../../lib/x.ts', undefined],
    ['@setu-ts/common', undefined],
    ['~/lib/x.ts', undefined],
  ])('%s → %s', (specifier, target) => {
    expect(kernelTarget(PAGE, specifier)).toBe(target);
  });
});

describe('scanPageImports', () => {
  it('walks app/**/*.{ts,tsx}, skips other files, and yields nothing without app/', async () => {
    const fs = createFakeFs({
      '/p/app/root.tsx': "import type { A } from '~kernel/modules/a/a.types.ts';\n",
      '/p/app/routes/bad.tsx': "import { aService } from '~kernel/modules/a/a.service.ts';\n",
      '/p/app/lib/util.ts': "import { aService } from '~kernel/modules/a/a.service.ts';\n",
      '/p/app/app.css': "@import '~kernel/modules/a/a.service.ts';\n",
      '/p/app/routes/broken.tsx': "import { x } from '~kernel/a.ts",
    });
    const scan = await scanPageImports(fs, '/p');
    expect(scan.violations.map((v) => v.path)).toEqual(['app/lib/util.ts', 'app/routes/bad.tsx']);
    expect(scan.unreadable).toEqual(['app/routes/broken.tsx']);
    expect(await scanPageImports(createFakeFs({ '/q/package.json': '{}' }), '/q')).toEqual({
      violations: [],
      unreadable: [],
    });
  });
});

describe('the full-stack output passes its own E017 check', () => {
  it('the template pages and a --page module page import only types and tokens', async () => {
    const { FULL_STACK_TEMPLATE } = await import('../../../src/templates/full-stack.ts');
    const { generateFullStackModule } =
      await import('../../../src/schematics/module-full-stack.ts');
    const { deriveNames } = await import('../../../src/utils/names.ts');
    const files = [
      ...(FULL_STACK_TEMPLATE.files ?? []),
      ...generateFullStackModule(deriveNames('articles'), { runtime: 'node', page: true }),
    ];
    // The same set scanPageImports walks: app/**/*.{ts,tsx}.
    const pages = files.filter((file) => /^app\/.*\.tsx?$/.test(file.path));
    expect(pages.some((file) => file.contents.includes('~kernel/'))).toBe(true);
    for (const file of pages)
      expect(await scanPageSource(file.path, file.contents), file.path).toEqual([]);
  });
});
