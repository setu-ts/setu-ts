/**
 * `setu g module` in a full-stack project, and `--page` (M130 §3.6, §3.8).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { generateModule } from '../../../src/schematics/module.ts';
import {
  generateFullStackModule,
  modulePagePath,
  renderSessionSupport,
} from '../../../src/schematics/module-full-stack.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { parseArgs } from '../../../src/args.ts';
import { runGenerateCommand } from '../../../src/commands/generate.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';

const names = deriveNames('articles');
const FULL_STACK = new Set(['react-router-plugin', 'session-plugin', 'common']);

function byPath(files: readonly { path: string; contents: string }[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`no ${path}`);
  return file.contents;
}

describe('generateModule in a full-stack project', () => {
  const files = generateModule(names, {
    runtime: 'node',
    plugins: FULL_STACK,
    modules: ['products'],
  });

  it('writes the request-bound module shape', () => {
    expect(files.map((file) => file.path)).toEqual([
      'src/modules/articles/articles.types.ts',
      'src/modules/articles/articles.service.ts',
      'src/modules/articles/articles.token.ts',
      'src/modules/articles/articles.controller.ts',
      'src/modules/articles/index.ts',
      'src/modules/index.ts',
      'src/modules/articles/articles.test.ts',
      'src/modules/articles/articles.e2e.test.ts',
      'test/support/server.ts',
      'test/support/session.ts',
    ]);
  });

  it('names the token module.<name> and serves /api/<name> through resolveRequestService', () => {
    expect(byPath(files, 'src/modules/articles/articles.token.ts')).toContain(
      "export const ARTICLES = requestServiceToken<ArticlesService>('module.articles');",
    );
    const controller = byPath(files, 'src/modules/articles/articles.controller.ts');
    expect(controller).toContain("router.group('/api/articles'");
    expect(controller).toContain('resolveRequestService(ctx, ARTICLES)');
    // The page is guarded; the API is not, and says so (M130 audit L-4).
    expect(controller).toContain('Not behind sign-in');
    expect(byPath(files, 'src/modules/articles/articles.service.ts')).toContain(
      'export function articlesService(ctx: IRequestContext): ArticlesService',
    );
  });

  it('registers the service from the managed index and lists every module', () => {
    expect(byPath(files, 'src/modules/articles/index.ts')).toContain(
      'services.register(ARTICLES, requestService(articlesService));',
    );
    const barrel = byPath(files, 'src/modules/index.ts');
    expect(barrel).toContain('registerArticlesModule(router, services);');
    expect(barrel).toContain('registerProductsModule(router, services);');
  });

  it('writes tests that sign a session and send its token on unsafe requests (X91-2)', () => {
    for (const path of [
      'src/modules/articles/articles.test.ts',
      'src/modules/articles/articles.e2e.test.ts',
    ]) {
      const test = byPath(files, path);
      expect(test, path).toContain(
        "import { signedSession } from '../../../test/support/session.ts';",
      );
      expect(test, path).toContain(
        "headers: session.headers({ 'content-type': 'application/json' })",
      );
    }
    expect(byPath(files, 'src/modules/articles/articles.e2e.test.ts')).toContain(
      'assert.deepStrictEqual(refused.status, 403);',
    );
    const support = renderSessionSupport();
    expect(support).toContain("await fetch(baseUrl + '/login')");
    expect(support).toContain("'x-csrf-token': token");
    expect(support).toContain('getSetCookie()');
  });

  it('writes no page without --page, and the page with it', () => {
    expect(files.some((file) => file.path === modulePagePath(names))).toBe(false);
    const withPage = generateFullStackModule(names, { runtime: 'deno', page: true });
    const page = byPath(withPage, 'app/routes/_app/articles._index.tsx');
    expect(page).toContain('export const middleware = [requireUser];');
    expect(page).toContain('await getService(context, ARTICLES).list()');
    expect(page).toContain(
      "import type { Articles } from '~kernel/modules/articles/articles.types.ts';",
    );
    expect(page).toContain(
      "import { ARTICLES } from '~kernel/modules/articles/articles.token.ts';",
    );
    // A page imports nothing else from the kernel by value (setu.E017).
    expect(page.match(/from '~kernel\//g)).toHaveLength(2);
  });

  it('uses the Deno harness idiom on Deno', () => {
    const deno = generateFullStackModule(names, { runtime: 'deno' });
    expect(byPath(deno, 'src/modules/articles/articles.test.ts')).toContain(
      'expect(created.status).toEqual(201);',
    );
  });
});

describe('generateModule outside full-stack is unchanged', () => {
  it('keeps the REST module shape, with no token, page or session helper', () => {
    const files = generateModule(names, { runtime: 'node', plugins: new Set() });
    const paths = files.map((file) => file.path);
    expect(paths).not.toContain('src/modules/articles/articles.token.ts');
    expect(paths).not.toContain('test/support/session.ts');
    expect(paths).not.toContain(modulePagePath(names));
    expect(byPath(files, 'src/modules/articles/articles.controller.ts')).toContain(
      "router.group('/articles'",
    );
  });
});

describe('setu generate module --page', () => {
  function project(manifest: Record<string, string>) {
    const fs = createFakeFs({
      '/app/package.json': JSON.stringify({ dependencies: manifest }),
      '/app/setu.config.ts': 'registerModules(app.router, app.services);',
      '/app/app/routes.ts': 'export default [];\n',
    });
    const out = createRecorder();
    const err = createRecorder();
    const run = (argv: readonly string[]) =>
      runGenerateCommand(parseArgs(argv), {
        fs,
        cwd: '/app',
        now: () => 0,
        log: out.sink,
        error: err.sink,
        runCommand: () => Promise.resolve({ code: 0, stdout: '[]', stderr: '' }),
      });
    return { fs, out, err, run };
  }

  it('writes the page route in a full-stack project', async () => {
    const h = project({ '@setu-ts/react-router-plugin': '^0.11.0', '@setu-ts/common': '^0.11.0' });
    expect(await h.run(['module', 'articles', '--page']), h.err.text()).toBe(0);
    expect(h.fs.has('/app/app/routes/_app/articles._index.tsx')).toBe(true);
    expect(h.fs.read('/app/src/modules/articles/index.ts')).toContain(
      'services.register(ARTICLES, requestService(articlesService));',
    );
  });

  it('lists the page route under --dry-run without writing it', async () => {
    const h = project({ '@setu-ts/react-router-plugin': '^0.11.0' });
    expect(await h.run(['module', 'articles', '--page', '--dry-run']), h.err.text()).toBe(0);
    expect(h.out.text()).toContain('app/routes/_app/articles._index.tsx');
    expect(h.fs.has('/app/app/routes/_app/articles._index.tsx')).toBe(false);
  });

  it('refuses --page outside full-stack, naming the template', async () => {
    const h = project({});
    expect(await h.run(['module', 'articles', '--page'])).toBe(2);
    expect(h.err.text()).toContain('--page needs the full-stack template');
    expect(h.fs.has('/app/src/modules/articles/index.ts')).toBe(false);
  });

  it('refuses --page in a class-based full-stack project (PR review)', async () => {
    const h = project({
      '@setu-ts/react-router-plugin': '^0.11.0',
      '@setu-ts/decorator-plugin': '^0.11.0',
    });
    expect(await h.run(['module', 'articles', '--page'])).toBe(2);
    expect(h.err.text()).toContain('--page needs functional generation');
    expect(h.fs.has('/app/src/modules/articles/index.ts')).toBe(false);
  });

  it('refuses --page on any schematic but module', async () => {
    const h = project({ '@setu-ts/react-router-plugin': '^0.11.0' });
    expect(await h.run(['service', 'billing', '--page'])).toBe(2);
    expect(h.err.text()).toContain('--page applies only to `g module`');
  });
});
