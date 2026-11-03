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
  [
    'a token module reached through the page alias',
    "import { PRODUCTS } from '~/../src/modules/products/products.token.ts';",
  ],
  ['a glob inside app', "const pages = import.meta.glob('./*.tsx');"],
  ['a glob over app through the page alias', "const all = import.meta.glob('~/routes/**/*.tsx');"],
  // Re-audit R-3: mentions of a glob in text, and exclusion-only patterns, are not reaches.
  ['a string mentioning import.meta.glob', 'const tip = "use import.meta.glob(x) carefully";'],
  [
    'JSX text mentioning import.meta.glob',
    "export default function P() {\n  return <p>import.meta.glob('/src/**') is refused</p>;\n}",
  ],
  ['an exclusion pattern over src/', "const pages = import.meta.glob(['./*.tsx', '!/src/**']);"],
  [
    'a glob with a base inside app',
    "const parts = import.meta.glob('./*.tsx', { base: './parts' });",
  ],
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
    'a token file outside a module, reached through a dot segment',
    "import { X } from '~kernel/modules/../shared.token.ts';",
    'value-import',
    1,
    '~kernel/modules/../shared.token.ts',
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
  // The security audit's bypasses (M130): every spelling the bundler resolves.
  [
    'the page alias climbing into src/',
    "import { productsService } from '~/../src/modules/products/products.service.ts';",
    'value-import',
    1,
    '~/../src/modules/products/products.service.ts',
  ],
  [
    'a root-absolute path into src/',
    "import { productsService } from '/src/modules/products/products.service.ts';",
    'value-import',
    1,
    '/src/modules/products/products.service.ts',
  ],
  [
    'a query suffix dressing a service as a token',
    "import { productsService } from '~kernel/modules/products/products.service.ts?x=.token.ts';",
    'value-import',
    1,
    '~kernel/modules/products/products.service.ts?x=.token.ts',
  ],
  [
    'a hash suffix dressing a service as a token',
    "import { productsService } from '~kernel/modules/products/products.service.ts#.token.ts';",
    'value-import',
    1,
    '~kernel/modules/products/products.service.ts#.token.ts',
  ],
  [
    'a kernel alias climbing out of src/',
    "import config from '~kernel/../setu.config.ts';",
    'value-import',
    1,
    '~kernel/../setu.config.ts',
  ],
  [
    'an eager glob over the services',
    "const services = import.meta.glob('/src/modules/*/*.service.ts', { eager: true });",
    'glob',
    1,
    '/src/modules/*/*.service.ts',
  ],
  [
    'a glob from above the project root of app/',
    "// first\nconst all = import.meta.glob('../../../**/*.ts');",
    'glob',
    2,
    '../../../**/*.ts',
  ],
  [
    'an array glob with one pattern into src/',
    "const mods = import.meta.glob(['./*.tsx', '~kernel/**/*.ts']);",
    'glob',
    1,
    '~kernel/**/*.ts',
  ],
  // Re-audit R-1: the glob's base option anchors relative patterns.
  [
    'a glob anchored in src/ by a root-absolute base',
    "const s = import.meta.glob('./**/*.service.ts', { eager: true, base: '/src/modules' });",
    'glob',
    1,
    './**/*.service.ts',
  ],
  [
    'a glob anchored in src/ by a relative base',
    "const s = import.meta.glob('./**/*.ts', { base: '../../../src/modules' });",
    'glob',
    1,
    './**/*.ts',
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

  it('reports a glob whose pattern it cannot read instead of passing it', async () => {
    const source = "const pattern = '/src/**';\nconst m = import.meta.glob(pattern);";
    expect(await scanPageSource(PAGE, source)).toBe('unreadable');
  });

  it.each([
    ['a computed base', "const d = '/src';\nconst m = import.meta.glob('./*.ts', { base: d });"],
    ['a spread options object', "const o = {};\nconst m = import.meta.glob('./*.ts', { ...o });"],
    ['an options identifier', "const o = {};\nconst m = import.meta.glob('./*.ts', o);"],
  ])('reports a glob with %s as unreadable', async (_label, source) => {
    expect(await scanPageSource(PAGE, source)).toBe('unreadable');
  });

  it('resolves the project absolute path, plain or behind /@fs (re-audit R-2)', async () => {
    for (const specifier of [
      '/proj/src/modules/a/a.service.ts',
      '/@fs/proj/src/modules/a/a.service.ts',
    ])
      expect(
        await scanPageSource(PAGE, `import { s } from '${specifier}';\nvoid s;`, '/proj'),
      ).toEqual([{ path: PAGE, line: 1, specifier, reason: 'value-import' }]);
    // Another directory's absolute path is not this project's kernel.
    expect(
      await scanPageSource(PAGE, "import { s } from '/elsewhere/src/a.ts';\nvoid s;", '/proj'),
    ).toEqual([]);
  });

  it('scans JavaScript pages too', async () => {
    const jsx =
      "import { s } from '../../../src/modules/a/a.service.ts';\nexport default () => <p>{s}</p>;";
    const page = 'app/routes/_app/legacy.jsx';
    expect(await scanPageSource(page, jsx)).toEqual([
      {
        path: page,
        line: 1,
        specifier: '../../../src/modules/a/a.service.ts',
        reason: 'value-import',
      },
    ]);
    expect(await scanPageSource('app/lib/x.mjs', "import '/src/a.ts';")).toHaveLength(1);
  });
});

describe('kernelTarget', () => {
  it.each([
    ['~kernel/modules/a/a.ts', 'src/modules/a/a.ts'],
    ['../../../src/modules/a/a.ts', 'src/modules/a/a.ts'],
    ['../../lib/x.ts', undefined],
    ['@setu-ts/common', undefined],
    ['~/lib/x.ts', undefined],
    ['~/../src/modules/a/a.ts', 'src/modules/a/a.ts'],
    ['/src/a.ts?raw', 'src/a.ts'],
    ['~kernel/../main.ts', 'src/../main.ts'],
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
      '/p/app/routes/legacy.jsx': "import { a } from '/src/modules/a/a.service.ts';\n",
      '/p/app/routes/broken.tsx': "import { x } from '~kernel/a.ts",
    });
    const scan = await scanPageImports(fs, '/p');
    expect(scan.violations.map((v) => v.path)).toEqual([
      'app/lib/util.ts',
      'app/routes/bad.tsx',
      'app/routes/legacy.jsx',
    ]);
    expect(scan.unreadable).toEqual(['app/routes/broken.tsx']);
    expect(await scanPageImports(createFakeFs({ '/q/package.json': '{}' }), '/q')).toEqual({
      violations: [],
      unreadable: [],
    });
  });
});

describe('scanPageImports bounds', () => {
  it('reports a page over 1 MiB as unreadable instead of reading it', async () => {
    const big = `import { aService } from '~kernel/modules/a/a.service.ts';\n${'//'.repeat(600_000)}`;
    const fs = createFakeFs({ '/p/app/routes/big.tsx': big });
    const read = fs.readFile.bind(fs);
    const opened: string[] = [];
    fs.readFile = (path: string) => {
      opened.push(path);
      return read(path);
    };
    const scan = await scanPageImports(fs, '/p');
    expect(scan).toEqual({ violations: [], unreadable: ['app/routes/big.tsx'] });
    expect(opened).toEqual([]);
  });

  it('ends a directory loop at the depth bound and reports where it stopped', async () => {
    // A symlinked directory that points at its parent: every level lists itself.
    const fs = createFakeFs({ '/p/app/root.tsx': '' });
    const readdir = fs.readdir.bind(fs);
    const stat = fs.stat.bind(fs);
    fs.readdir = async (path: string) =>
      path === '/p/app'
        ? [...(await readdir(path)), 'loop']
        : path.startsWith('/p/app/loop')
          ? ['loop']
          : readdir(path);
    fs.stat = (path: string) =>
      path.startsWith('/p/app/loop')
        ? Promise.resolve({ isFile: false, isDirectory: true, size: 0 })
        : stat(path);
    const scan = await scanPageImports(fs, '/p');
    expect(scan.violations).toEqual([]);
    expect(scan.unreadable).toEqual([`app${'/loop'.repeat(33)}`]);
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
