/**
 * One home for controllers and services (§4.8, §4.9): the `--module` rules as
 * data, `g sse --module`, `setu add view` placement, and the E014–E016 findings
 * with what `generate` and `sync` do about them.
 */
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { withRelocatedDeclarationImports } from '../../src/utils/module-declaration.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';

type Style = 'functional' | 'class-based';

/** A source-rendered REST scaffold with `sse-plugin` installed, optionally switched to modules. */
async function project(style: Style, modular: boolean) {
  const host = style === 'class-based' ? REST_TEMPLATE.classBased! : REST_TEMPLATE;
  const seed: Record<string, string> = {};
  for (const file of projectFiles('svc', 'node', resolveHost(host, 'node')))
    seed[`/app/${file.path}`] = file.contents;
  const manifest = JSON.parse(seed['/app/package.json']!);
  manifest.dependencies['@setu-ts/sse-plugin'] = '^0.10.0';
  seed['/app/package.json'] = JSON.stringify(manifest);
  const fs = createFakeFs(seed);
  const out = createRecorder();
  const err = createRecorder();
  const run = (argv: readonly string[]): Promise<number> =>
    runCli(argv, { fs, cwd: '/app', now: () => 0, log: out.sink, error: err.sink });
  if (modular) expect(await run(['g', 'module', 'shop', '--adopt-controllers'])).toBe(0);
  return { fs, out, err, run };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the --module rules', () => {
  // The §4.8 table, as data: [schematic, flat with --module, modular without --module].
  const RULES: readonly (readonly [string, number, number])[] = [
    ['controller', 1, 2],
    ['route', 1, 2],
    ['service', 1, 2],
    ['sse', 1, 2],
  ];
  for (const style of ['functional', 'class-based'] as const)
    for (const [schematic, flatCode, modularCode] of RULES) {
      it(`${style} ${schematic}: --module only where the project has modules`, async () => {
        const flat = await project(style, false);
        expect(await flat.run(['g', schematic, 'parcels', '--module', 'shop'])).toBe(flatCode);
        expect(flat.err.text()).toContain('This project has no modules; run `');
        expect(flat.err.text()).toContain('g module shop` first, or drop --module.');
        expect(await flat.run(['g', schematic, 'parcels'])).toBe(0);

        const modular = await project(style, true);
        expect(await modular.run(['g', schematic, 'parcels'])).toBe(modularCode);
        expect(modular.err.text()).toContain(
          'This project uses modules; pass --module <name> (existing: shop).',
        );
        expect(await modular.run(['g', schematic, 'parcels', '--module', 'shop'])).toBe(0);
        expect(
          modular.fs.has(
            `/app/src/modules/shop/parcels.${schematic === 'service' ? 'service' : 'controller'}.ts`,
          ),
        ).toBe(true);
      });
    }

  it('serves a module SSE controller under the module and registers it', async () => {
    for (const style of ['functional', 'class-based'] as const) {
      const h = await project(style, true);
      expect(await h.run(['g', 'sse', 'feed', '--module', 'shop'])).toBe(0);
      const controller = h.fs.read('/app/src/modules/shop/feed.controller.ts');
      if (style === 'functional') {
        expect(controller).toContain("router.get('/shop/sse/feed'");
        expect(h.fs.read('/app/src/modules/shop/index.ts')).toContain(
          '  registerFeedRoutes(router, services);',
        );
      } else {
        expect(controller).toContain("@Controller('/shop/sse/feed')");
        expect(h.fs.read('/app/src/modules/shop/shop.module.ts')).toContain('FeedController]');
      }
    }
  });
});

describe('setu add view placement', () => {
  it('writes the views controller into the flat barrel, or a named module', async () => {
    const flat = await project('functional', false);
    expect(await flat.run(['add', 'view'])).toBe(0);
    expect(flat.fs.read('/app/src/controllers/views.controller.ts')).toContain(
      "import { Home } from '../views/home.tsx';",
    );
    expect(flat.fs.read('/app/src/controllers/index.ts')).toContain(
      "import { registerViewsRoutes } from './views.controller.ts';",
    );
    expect(flat.fs.has('/app/src/views/routes.ts')).toBe(false);
    expect(flat.fs.read('/app/setu.config.ts')).not.toContain('registerViewRoutes');

    const modular = await project('class-based', true);
    expect(await modular.run(['add', 'view', '--module', 'shop'])).toBe(0);
    expect(modular.fs.read('/app/src/modules/shop/views.controller.ts')).toContain(
      "import { Home } from '../../views/home.tsx';",
    );
    expect(modular.fs.read('/app/src/modules/shop/index.ts')).toContain(
      '  registerViewsRoutes(router, services);',
    );
  });

  it('says when the config never calls the registrar the views controller joins', async () => {
    const h = await project('functional', false);
    const config = h.fs.read('/app/setu.config.ts');
    await h.fs.writeFile(
      '/app/setu.config.ts',
      encode(config.replace('  registerGeneratedRoutes(app.router, app.services);\n', '')),
    );
    expect(await h.run(['add', 'view'])).toBe(0);
    expect(h.out.text()).toContain(
      'setu.config.ts does not call registerGeneratedRoutes; add registerGeneratedRoutes(app.router, app.services); so /ui is registered.',
    );
    const wired = await project('functional', false);
    expect(await wired.run(['add', 'view'])).toBe(0);
    expect(wired.out.text()).not.toContain('does not call registerGeneratedRoutes');
  });

  it('refuses a placement that breaks the rule, writing nothing', async () => {
    const cases: readonly (readonly [boolean, readonly string[], number, string])[] = [
      [
        true,
        ['add', 'view'],
        2,
        'This project uses modules; pass --module <name> to place the views controller (existing: shop).',
      ],
      [
        true,
        ['add', 'view', '--module', 'nope'],
        1,
        'Unknown module "nope". Admitted modules: shop.',
      ],
      [false, ['add', 'view', '--module', 'shop'], 1, 'This project has no modules; drop --module'],
      [false, ['add', 'cache', '--module', 'shop'], 2, '--module applies only to `setu add view`'],
      [
        false,
        ['add', 'view', '--module', 'Bad Name'],
        2,
        'Option --module requires a valid module name.',
      ],
    ];
    for (const [modular, argv, code, message] of cases) {
      const h = await project('functional', modular);
      const writes = h.fs.writes.length;
      expect(await h.run(argv), argv.join(' ')).toBe(code);
      expect(h.err.text(), argv.join(' ')).toContain(message);
      expect(h.fs.writes.length, argv.join(' ')).toBe(writes);
    }
  });
});

describe('setu check, generate and sync on the one-home findings', () => {
  it('reports controllers left outside modules (E014)', async () => {
    const h = await project('functional', true);
    await h.fs.writeFile(
      '/app/src/controllers/stray.controller.ts',
      encode('export function registerStrayRoutes(): void {}\n'),
    );
    expect(await h.run(['check'])).toBe(1);
    expect(h.err.text()).toContain(
      'error setu.E014: This project has modules and also keeps controllers or services outside them: src/controllers/stray.controller.ts.',
    );
    // generate says so too, beside its own refusal.
    expect(await h.run(['g', 'controller', 'other'])).toBe(2);
    expect(h.err.text()).toContain(
      'This project has modules and also keeps controllers or services outside them: src/controllers/stray.controller.ts.\n',
    );
  });

  it('reports an import in a CLI-written file that no longer resolves (E015)', async () => {
    for (const style of ['functional', 'class-based'] as const) {
      const h = await project(style, true);
      await h.fs.rm('/app/src/modules/shop/shop.service.ts');
      if (style === 'functional') await h.fs.rm('/app/src/modules/shop/greeting.controller.ts');
      expect(await h.run(['check']), style).toBe(1);
      expect(h.err.text(), style).toContain(
        style === 'functional'
          ? 'error setu.E015: src/modules/shop/index.ts imports ./greeting.controller.ts, which does not exist.'
          : 'error setu.E015: src/modules/shop/shop.module.ts imports ./shop.service.ts, which does not exist.',
      );
    }
  });

  it('reports two controllers with one base name (E016), and generate and sync refuse', async () => {
    const h = await project('functional', false);
    for (const dir of ['a', 'b'])
      await h.fs.writeFile(
        `/app/src/controllers/${dir}/twin.controller.ts`,
        encode('export function registerTwinRoutes(): void {}\n'),
      );
    expect(await h.run(['check'])).toBe(1);
    expect(h.err.text()).toContain('error setu.E016: Two controller files share a base name');
    const writes = h.fs.writes.length;
    for (const argv of [['g', 'controller', 'other'], ['sync']]) {
      expect(await h.run(argv), argv.join(' ')).toBe(1);
      expect(h.err.text()).toContain(
        'Duplicate controller base name: src/controllers/a/twin.controller.ts, src/controllers/b/twin.controller.ts. Rename one file before generating or syncing.',
      );
    }
    expect(h.fs.writes.length).toBe(writes);
  });

  it('re-points a class-based declaration at a controller moved into a subfolder', async () => {
    const h = await project('class-based', true);
    const moved = h.fs.read('/app/src/modules/shop/greeting.controller.ts');
    await h.fs.rm('/app/src/modules/shop/greeting.controller.ts');
    await h.fs.writeFile(
      '/app/src/modules/shop/http/greeting.controller.ts',
      encode(moved.replace("'./greeting.service.ts'", "'../greeting.service.ts'")),
    );
    expect(await h.run(['sync'])).toBe(0);
    expect(h.fs.read('/app/src/modules/shop/shop.module.ts')).toContain(
      "import { GreetingController } from './http/greeting.controller.ts';",
    );
    expect(await h.run(['check'])).toBe(0);
  });
});

describe('setu sync and an unreadable module file', () => {
  it('leaves that module index and declaration as they are', async () => {
    for (const style of ['functional', 'class-based'] as const) {
      const h = await project(style, true);
      const index = '/app/src/modules/shop/index.ts';
      const declaration = '/app/src/modules/shop/shop.module.ts';
      // Stale on purpose: sync would normally rewrite both.
      await h.fs.writeFile(index, encode('export function registerShopModule(): void {}\n'));
      if (style === 'class-based')
        await h.fs.writeFile(
          declaration,
          encode(
            h.fs.read(declaration).replace("'./shop.service.ts'", "'./moved/shop.service.ts'"),
          ),
        );
      const before = [h.fs.read(index), h.fs.has(declaration) ? h.fs.read(declaration) : ''];
      const broken = '/app/src/modules/shop/locked.controller.ts';
      await h.fs.writeFile(broken, encode('export function registerLockedRoutes(): void {}\n'));
      const readFile = h.fs.readFile.bind(h.fs);
      h.fs.readFile = (path) =>
        path === broken
          ? Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
          : readFile(path);
      expect(await h.run(['sync']), style).toBe(1);
      expect(h.err.text(), style).toContain('setu.E013');
      expect(
        [h.fs.read(index), h.fs.has(declaration) ? h.fs.read(declaration) : ''],
        style,
      ).toEqual(before);
    }
  });
});

describe('withRelocatedDeclarationImports', () => {
  const declaration = [
    "import { Module } from '@setu-ts/decorator-plugin';",
    "import { AController } from './a.controller.ts';",
    "import { BService } from './b.service.ts';",
    "import { helper } from './helper.ts';",
    '@Module({ controllers: [AController], providers: [BService] })',
    'export class MModule {}',
    '',
  ].join('\n');

  it('rewrites only unresolved controller and service imports with one match', () => {
    expect(
      withRelocatedDeclarationImports(declaration, [
        'web/a.controller.ts',
        'domain/b.service.ts',
        'other.ts',
      ]),
    ).toBe(
      declaration
        .replace("'./a.controller.ts'", "'./web/a.controller.ts'")
        .replace("'./b.service.ts'", "'./domain/b.service.ts'"),
    );
  });

  it('changes nothing when every import resolves, a match is ambiguous, or the file cannot be read', () => {
    expect(
      withRelocatedDeclarationImports(declaration, ['a.controller.ts', 'b.service.ts']),
    ).toBeUndefined();
    expect(
      withRelocatedDeclarationImports(declaration, ['x/a.controller.ts', 'y/a.controller.ts']),
    ).toBeUndefined();
    expect(
      withRelocatedDeclarationImports(`const t = \`\${x`, ['a.controller.ts']),
    ).toBeUndefined();
  });
});
