/**
 * `setu.E017` page-kernel-value-import (M130 §3.7). The accepted and refused
 * shapes are a data table, so the module comment cannot claim a set the scanner
 * does not implement.
 *
 * @module
 */
import * as nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../../test/node-helpers.ts';
import {
  globReachesKernel,
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
  // Review finding 7: the bundler and Node/Bun type-checking resolve these to the token file.
  [
    'an extensionless token module',
    "import { PRODUCTS } from '~kernel/modules/products/products.token';",
  ],
  ['a .js token module', "import { PRODUCTS } from '~kernel/modules/products/products.token.js';"],
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
    'an eager glob picking the default export',
    "const pages = import.meta.glob('./*.tsx', { eager: true, import: 'default' });",
  ],
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
  // Re-audit N-1, N-2, N-4: globs are read from tokens, not from masked text.
  [
    'a glob after a regex literal holding a quote',
    "const re = /'/;\nconst s = import.meta.glob('/src/modules/*/*.service.ts', { eager: true });",
    'glob',
    2,
    '/src/modules/*/*.service.ts',
  ],
  [
    'a glob inside a template substitution',
    "const t = `${Object.keys(import.meta.glob('/src/modules/*/*.service.ts', { eager: true }))}`;",
    'glob',
    1,
    '/src/modules/*/*.service.ts',
  ],
  [
    'a real base hidden behind a commented one',
    "const s = import.meta.glob('./**/*.service.ts', { eager: true, /* base: './' */ base: '/src/modules' });",
    'glob',
    1,
    './**/*.service.ts',
  ],
  [
    'a base after a query record whose strings look like braces',
    'const s = import.meta.glob(\'./*/*.service.ts\', { eager: true, query: { "}": "}", ")": "}" }, base: "/src/modules" });',
    'glob',
    1,
    './*/*.service.ts',
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
    // Re-audit N-3: a computed key could be `base`.
    [
      'a computed key',
      "const m = import.meta.glob('./**/*.ts', { eager: true, ['base']: '/src/modules' });",
    ],
    ['a shorthand base', "const base = '/src';\nconst m = import.meta.glob('./*.ts', { base });"],
    ['the function used as a value', "const g = import.meta.glob;\nconst m = g('/src/**/*.ts');"],
  ])('reports a glob with %s as unreadable', async (_label, source) => {
    expect(await scanPageSource(PAGE, source)).toBe('unreadable');
  });

  it('reports each glob call on its own line (re-audit N-5)', async () => {
    const source = [
      "const a = import.meta.glob('./*.tsx');",
      "const b = import.meta.glob('/src/a/*.ts');",
      "// const c = import.meta.glob('/src/c/*.ts');",
      "const d = import.meta.glob('./parts/*.tsx');",
      "const e = import.meta.glob('/src/e/*.ts');",
      "const f = import.meta.glob('~kernel/f/*.ts');",
    ].join('\n');
    const found = await scanPageSource(PAGE, source);
    expect(found).not.toBe('unreadable');
    expect((found as readonly { line: number }[]).map((v) => v.line)).toEqual([2, 5, 6]);
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

describe('globReachesKernel', () => {
  it.each([
    ['a pattern without a wildcard', 'app/p.tsx', '../src/a.ts', undefined, true],
    ['a bare wildcard beside the page', 'app/p.tsx', '*.tsx', undefined, false],
    ['a bare subdirectory pattern', 'app/p.tsx', 'parts/*.tsx', undefined, false],
    ['a bare base joined as relative', 'p.tsx', './*.ts', 'src', true],
    ['an unknown alias', 'app/p.tsx', '~other/*.ts', undefined, false],
    ['an exclusion', 'app/p.tsx', '!/src/**', undefined, false],
  ] as const)('%s', (_label, file, pattern, base, reaches) => {
    expect(globReachesKernel(file, pattern, base)).toBe(reaches);
  });

  it('resolves a page at the project root', () => {
    expect(kernelTarget('page.tsx', './src/a.ts')).toBe('src/a.ts');
  });
});

describe('scanPageSource edge cases', () => {
  it('reports a page whose emitted code the lexer cannot classify', async () => {
    expect(await scanPageSource(PAGE, "const x = require('./a.ts');\nvoid x;")).toBe('unreadable');
  });

  it('reports on line 1 when JSX text also mentions the glob', async () => {
    const source =
      "const s = import.meta.glob('/src/**/*.ts');\nexport default () => <p>import.meta.glob(x)</p>;";
    expect(await scanPageSource(PAGE, source)).toEqual([
      { path: PAGE, line: 1, specifier: '/src/**/*.ts', reason: 'glob' },
    ]);
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

describe('token imports written without .ts (re-audit L-7)', () => {
  const page = (specifier: string) => `import { T } from '${specifier}';\nvoid T;\n`;
  const TOKEN = 'src/modules/m/x.token';
  for (const [label, specifier, files, refused] of [
    ['extensionless, .ts present', '~kernel/modules/m/x.token', [`${TOKEN}.ts`], false],
    ['.js spelling, .ts present', '~kernel/modules/m/x.token.js', [`${TOKEN}.ts`], false],
    [
      'extensionless, a directory beside the .ts',
      '~kernel/modules/m/x.token',
      [`${TOKEN}.ts`, `${TOKEN}/index.ts`],
      false,
    ],
    [
      'extensionless, only a directory index',
      '~kernel/modules/m/x.token',
      [`${TOKEN}/index.ts`],
      true,
    ],
    ['extensionless, only a .tsx', '~kernel/modules/m/x.token', [`${TOKEN}.tsx`], true],
    [
      'extensionless, a .js shadows the .ts',
      '~kernel/modules/m/x.token',
      [`${TOKEN}.ts`, `${TOKEN}.js`],
      true,
    ],
    [
      'extensionless, a file at the exact path',
      '~kernel/modules/m/x.token',
      [`${TOKEN}.ts`, TOKEN],
      true,
    ],
    [
      '.js spelling, a .js file exists',
      '~kernel/modules/m/x.token.js',
      [`${TOKEN}.ts`, `${TOKEN}.js`],
      true,
    ],
  ] as const) {
    it(`${refused ? 'refuses' : 'accepts'} ${label}`, async () => {
      const fs = createFakeFs({
        '/p/app/routes/a.tsx': page(specifier),
        ...Object.fromEntries(files.map((file) => [`/p/${file}`, 'export const T = 1;\n'])),
      });
      const scan = await scanPageImports(fs, '/p');
      expect(scan.unreadable).toEqual([]);
      expect(scan.violations).toEqual(
        refused ? [{ path: 'app/routes/a.tsx', line: 1, specifier, reason: 'value-import' }] : [],
      );
    });
  }

  it('refuses when a candidate the bundler tries first cannot be read', async () => {
    const fs = createFakeFs({
      '/p/app/routes/a.tsx': page('~kernel/modules/m/x.token'),
      [`/p/${TOKEN}.ts`]: 'export const T = 1;\n',
    });
    const stat = fs.stat.bind(fs);
    fs.stat = (path: string) =>
      path === `/p/${TOKEN}.mjs`
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : stat(path);
    expect((await scanPageImports(fs, '/p')).violations.map((v) => v.reason)).toEqual([
      'value-import',
    ]);
  });

  it('accepts the spelling alone when scanning source without a filesystem', async () => {
    expect(await scanPageSource('app/a.tsx', page('~kernel/modules/m/x.token'))).toEqual([]);
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
    // Without realPath the depth bound is what ends the walk.
    const fs = { ...createFakeFs({ '/p/app/root.tsx': '' }) };
    delete (fs as { realPath?: unknown }).realPath;
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

  it('ends several directory loops at the directory bound without realPath', async () => {
    // Re-audit L-8: two links per level double the walk at every level, so the
    // depth bound alone would visit 2^32 directories.
    const fs = { ...createFakeFs({ '/p/app/root.tsx': '' }) };
    delete (fs as { realPath?: unknown }).realPath;
    const readdir = fs.readdir.bind(fs);
    const stat = fs.stat.bind(fs);
    const looped = (path: string) => /^\/p\/app\/[xy](\/|$)/.test(path);
    fs.readdir = async (path: string) =>
      path === '/p/app'
        ? [...(await readdir(path)), 'x', 'y']
        : looped(path)
          ? ['x', 'y']
          : readdir(path);
    fs.stat = (path: string) =>
      looped(path) ? Promise.resolve({ isFile: false, isDirectory: true, size: 0 }) : stat(path);
    let listed = 0;
    const counted = fs.readdir;
    fs.readdir = (path: string) => {
      listed += 1;
      return counted(path);
    };
    const scan = await scanPageImports(fs, '/p');
    expect(listed).toBe(4096);
    expect(scan.violations).toEqual([]);
    expect(scan.unreadable.length).toBeGreaterThan(0);
    expect(scan.unreadable.every((path) => /^app(\/[xy])+$/.test(path))).toBe(true);
  });
});

describe('scanPageImports over real symlinks (review finding 6)', () => {
  it('walks a looped directory once and refuses a link out of app/', async () => {
    const root = await tempDir({ prefix: 'page-walk-' });
    try {
      await nodeFs.mkdir(`${root}/app/routes`, { recursive: true });
      await nodeFs.writeFile(
        `${root}/app/routes/bad.tsx`,
        "import { s } from '~kernel/modules/a/a.service.ts';\nvoid s;\n",
      );
      await nodeFs.symlink('.', `${root}/app/x`);
      await nodeFs.symlink('.', `${root}/app/y`);
      await nodeFs.symlink('..', `${root}/app/out`);
      const scan = await scanPageImports(createNodeRuntimeServices().fs!, root);
      expect(scan.violations.map((v) => v.path)).toEqual(['app/routes/bad.tsx']);
      expect(scan.unreadable).toEqual(['app/out']);
    } finally {
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a page file a symlink places outside app/ (re-audit L-6)', async () => {
    const root = await tempDir({ prefix: 'page-walk-' });
    try {
      await nodeFs.mkdir(`${root}/app/routes`, { recursive: true });
      await nodeFs.mkdir(`${root}/app/lib`, { recursive: true });
      await nodeFs.mkdir(`${root}/src/modules/products`, { recursive: true });
      await nodeFs.writeFile(
        `${root}/src/modules/products/products.service.ts`,
        'export const s = 1;\n',
      );
      await nodeFs.writeFile(
        `${root}/app/routes/ok.tsx`,
        "import { a } from '~/lib/a.ts';\nvoid a;\n",
      );
      await nodeFs.writeFile(`${root}/app/lib/a.ts`, 'export const a = 1;\n');
      await nodeFs.symlink(
        '../../src/modules/products/products.service.ts',
        `${root}/app/routes/g.ts`,
      );
      await nodeFs.symlink(
        '../../src/modules/products/products.service.ts',
        `${root}/app/lib/svc.ts`,
      );
      await nodeFs.symlink('a.ts', `${root}/app/lib/alias.ts`);
      const scan = await scanPageImports(createNodeRuntimeServices().fs!, root);
      expect(scan).toEqual({ violations: [], unreadable: ['app/lib/svc.ts', 'app/routes/g.ts'] });
    } finally {
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a page file it cannot resolve', async () => {
    const fs = createFakeFs({ '/p/app/a.tsx': '', '/p/app/b.tsx': '' });
    const realPath = fs.realPath!.bind(fs);
    fs.realPath = (path: string) =>
      path === '/p/app/b.tsx'
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : realPath(path);
    expect(await scanPageImports(fs, '/p')).toEqual({ violations: [], unreadable: ['app/b.tsx'] });
  });

  it('reports an entry whose stat fails instead of throwing', async () => {
    const fs = createFakeFs({ '/p/app/root.tsx': '' });
    const readdir = fs.readdir.bind(fs);
    fs.readdir = async (path: string) =>
      path === '/p/app' ? [...(await readdir(path)), 'broken'] : readdir(path);
    const stat = fs.stat.bind(fs);
    fs.stat = (path: string) =>
      path === '/p/app/broken'
        ? Promise.reject(Object.assign(new Error('ELOOP'), { code: 'ELOOP' }))
        : stat(path);
    expect(await scanPageImports(fs, '/p')).toEqual({ violations: [], unreadable: ['app/broken'] });
  });

  it('reports a directory it cannot list instead of throwing', async () => {
    const fs = createFakeFs({ '/p/app/routes/a.tsx': '' });
    const readdir = fs.readdir.bind(fs);
    fs.readdir = (path: string) =>
      path === '/p/app/routes'
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : readdir(path);
    expect(await scanPageImports(fs, '/p')).toEqual({ violations: [], unreadable: ['app/routes'] });
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
