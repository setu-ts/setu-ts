/**
 * `setu g module` in a full-stack project, and `--page` (M130 §3.6, §3.8).
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { transform } from 'esbuild';
import { format } from 'prettier';
import { generateModule } from '../../../src/schematics/module.ts';
import {
  generateFullStackModule,
  modulePagePath,
  PAGES_SUPPORT_PATH,
  renderPagesSupport,
  renderSessionSupport,
  renderSignInSupport,
  SIGN_IN_SUPPORT_PATH,
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

interface ITestSession {
  readonly cookie: string;
  readonly token: string;
  readonly headers: (extra?: Record<string, string>) => Record<string, string>;
}

async function sessionHelpers(): Promise<{
  signIn: (baseUrl: string, session: ITestSession, email?: string) => Promise<string>;
  signedSession: (baseUrl: string) => Promise<ITestSession>;
  signedInSession: (baseUrl: string, email?: string) => Promise<ITestSession>;
}> {
  const source =
    renderSignInSupport() +
    renderSessionSupport().replace("import { signIn } from './sign-in.ts';", '');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  return import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`);
}

describe('rendered session helpers', () => {
  it.each(['node', 'deno', 'bun'] as const)(
    'keeps %s helpers and page tests formatted',
    async (runtime) => {
      const generated = generateFullStackModule(names, { runtime, page: true });
      for (const path of [
        'test/support/session.ts',
        SIGN_IN_SUPPORT_PATH,
        'src/modules/articles/articles.e2e.test.ts',
      ]) {
        const source = byPath(generated, path);
        expect(
          await format(source, {
            parser: 'typescript',
            printWidth: 100,
            singleQuote: true,
          }),
          path,
        ).toBe(source);
      }
    },
  );

  it.each([302, 303])(
    'signs in with the default email and joins cookies after %s',
    async (status) => {
      const helpers = await sessionHelpers();
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          status,
          headers: [
            ['set-cookie', 'session=rotated; HttpOnly'],
            ['set-cookie', 'other=value; Path=/'],
          ],
        }),
      );
      try {
        expect(
          await helpers.signIn('http://app', {
            cookie: 'session=anonymous',
            token: 'csrf',
            headers: () => ({}),
          }),
        ).toBe('session=rotated; other=value');
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe('http://app/login');
        expect(init).toMatchObject({
          method: 'POST',
          redirect: 'manual',
          headers: {
            cookie: 'session=anonymous',
            'content-type': 'application/x-www-form-urlencoded',
          },
        });
        expect(String(init?.body)).toBe('email=e2e%40example.test&_csrf=csrf');
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it.each([
    [200, 'session=unexpected', 'POST /login did not redirect after sign-in.'],
    [303, '', 'POST /login returned no rotated session cookie.'],
  ] as const)('rejects a broken placeholder sign-in (%s)', async (status, cookie, error) => {
    const helpers = await sessionHelpers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status,
        headers: cookie === '' ? {} : { 'set-cookie': cookie },
      }),
    );
    try {
      await expect(
        helpers.signIn('http://app', {
          cookie: 'session=anonymous',
          token: 'csrf',
          headers: () => ({}),
        }),
      ).rejects.toThrow(error);
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses the anonymous token to sign in and returns the rotated cookie, token and headers', async () => {
    const helpers = await sessionHelpers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('<input name="_csrf" value="anonymous-token">', {
          headers: { 'set-cookie': 'session=anonymous; HttpOnly' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'session=signed-in; HttpOnly' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<input name="_csrf" value="rotated-token">', {
          headers: { 'set-cookie': 'session=refreshed; HttpOnly' },
        }),
      );
    try {
      const session = await helpers.signedInSession('http://app', 'custom@example.test');
      expect(session.cookie).toBe('session=refreshed');
      expect(session.token).toBe('rotated-token');
      expect(session.headers({ accept: 'text/html' })).toEqual({
        cookie: 'session=refreshed',
        'x-csrf-token': 'rotated-token',
        accept: 'text/html',
      });
      expect(String(fetch.mock.calls[1]?.[1]?.body)).toBe(
        'email=custom%40example.test&_csrf=anonymous-token',
      );
      expect(fetch.mock.calls[2]).toEqual([
        'http://app/login',
        {
          headers: { cookie: 'session=signed-in' },
        },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });
});

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
      'test/support/sign-in.ts',
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
    for (const path of ['src/modules/articles/articles.e2e.test.ts']) {
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
      'expect(await service.get(record.id)).toEqual(record);',
    );
  });

  it.each([
    [{}, true, false],
    [{ page: true }, false, true],
    [{ page: true, api: true }, true, true],
  ] as const)('selects controller, index and e2e paths for %j', (options, api, page) => {
    const generated = generateFullStackModule(names, { runtime: 'node', ...options });
    expect(generated.some((file) => file.path.endsWith('.controller.ts'))).toBe(api);
    expect(
      byPath(generated, 'src/modules/articles/index.ts').includes('articles.controller.ts'),
    ).toBe(api);
    const test = byPath(generated, 'src/modules/articles/articles.e2e.test.ts');
    expect(test.includes('await signedSession(')).toBe(true);
    expect(test.includes('await signedInSession(')).toBe(page);
    expect(generated.find((file) => file.path === SIGN_IN_SUPPORT_PATH)).toEqual({
      path: SIGN_IN_SUPPORT_PATH,
      createOnly: true,
      contents: renderSignInSupport(),
    });
    expect(byPath(generated, 'test/support/session.ts')).toContain(
      "import { signIn } from './sign-in.ts';",
    );
    if (page) {
      const source = byPath(generated, modulePagePath(names));
      for (const fragment of [
        'export async function action',
        'getCsrfToken(context)',
        "service.parse({ name: form.get('name') })",
        "redirect('/articles', 303)",
        "'routes/_app/articles._index'",
        "on: 'action'",
        "<Form method='post'>",
        "name='_csrf'",
        'useActionData<typeof action>()',
      ])
        expect(source).toContain(fragment);
      for (const fragment of [
        "'/articles.data?index'",
        'A non-empty name is required.',
        'session.token',
        "created.headers.get('location')",
        'Data example',
        'import { signedInSession, signedSession }',
        'unsigned.status, 302',
        "unsigned.headers.get('location'), '/login'",
        "name: 'Anonymous refusal', _csrf: anonymous.token",
        "(await afterUnsigned.text()).includes('Anonymous refusal'), false",
      ])
        expect(test).toContain(fragment);
      expect(test).toContain("created.headers.get('location'), '/articles'");
      expect(test).toContain(
        "import { pageData, postForm } from '../../../test/support/pages.ts';",
      );
      expect(test).toContain("postForm(\n        server.baseUrl,\n        '/articles?index',");
      expect(test).toContain("'routes/_app/articles._index',\n        session,");
      expect(test).toContain("loadedNames.includes('Example')");
      for (const request of ['invalid', 'refused', 'unsigned']) {
        expect(test).toContain(
          `const ${request} = await fetch(server.baseUrl + '/articles?index',`,
        );
      }
      expect(test).not.toContain('${names.');
    }
  });

  it('shares trimmed-name parsing across both write paths and tests it', () => {
    const service = byPath(files, 'src/modules/articles/articles.service.ts');
    expect(service).toContain('parse(value: { readonly name?: unknown }): ArticlesInput | string');
    expect(service).toContain('value.name.trim()');
    const controller = byPath(files, 'src/modules/articles/articles.controller.ts');
    expect(controller).not.toContain('inputOf');
    expect(controller.match(/service.parse\(/g)).toHaveLength(2);
    expect(controller).toContain('throw badRequest(input)');
    expect(byPath(files, 'src/modules/articles/articles.test.ts')).toContain('service.parse(');
    const support = renderSessionSupport();
    const signIn = renderSignInSupport();
    expect(signIn).toContain("email = 'e2e@example.test'");
    expect(signIn).toContain('placeholder sign-in');
    expect(signIn).toContain('setu writes it once and never overwrites it');
    expect(support).toContain('Regenerated by setu g module; do not edit');
    expect(support).toContain('test/support/sign-in.ts, which the application owns');
    expect(support).toContain('await signIn(baseUrl, anonymous, email)');
    expect(support).not.toContain("method: 'POST'");
    expect(support).toContain('cookie =');
    expect(support.match(/await fetch\(baseUrl \+ '\/login'/g)).toHaveLength(2);
  });

  it('refuses api without page in the schematic itself', () => {
    expect(() => generateFullStackModule(names, { runtime: 'node', api: true })).toThrow(
      '--api applies with --page: a module without a page is already reached through its /api routes.',
    );
    expect(() =>
      generateModule(names, { runtime: 'node', plugins: FULL_STACK, api: true }),
    ).toThrow('--api applies with --page');
    expect(
      generateModule(names, { runtime: 'node', plugins: FULL_STACK, page: true, api: true }).some(
        (file) => file.path.endsWith('.controller.ts'),
      ),
    ).toBe(true);
    expect(
      generateFullStackModule(names, { runtime: 'cloudflare-workers', page: true }).some((file) =>
        file.path.endsWith('/articles.test.ts'),
      ),
    ).toBe(false);
    for (const plugins of [
      new Set<string>(),
      new Set(['react-router-plugin', 'decorator-plugin']),
    ]) {
      expect(() =>
        generateModule(names, { runtime: 'node', plugins, page: true, api: true }),
      ).toThrow();
    }
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
    expect(h.fs.has('/app/src/modules/articles/articles.controller.ts')).toBe(false);
    expect(h.fs.read('/app/src/modules/articles/index.ts')).toContain(
      'services.register(ARTICLES, requestService(articlesService));',
    );
  });

  it('passes --api through only with --page', async () => {
    const h = project({ '@setu-ts/react-router-plugin': '^0.13.0' });
    expect(await h.run(['module', 'articles', '--api'])).toBe(2);
    expect(h.err.text()).toContain(
      '--api applies with --page: a module without a page is already reached through its /api routes.',
    );
    expect(await h.run(['module', 'articles', '--page', '--api']), h.err.text()).toBe(0);
    expect(h.fs.has('/app/src/modules/articles/articles.controller.ts')).toBe(true);
  });

  it.each([
    [{}, ['module', 'articles'], 'full-stack template'],
    [
      { '@setu-ts/react-router-plugin': '^0.13.0', '@setu-ts/decorator-plugin': '^0.13.0' },
      ['module', 'articles'],
      'functional generation',
    ],
    [{ '@setu-ts/react-router-plugin': '^0.13.0' }, ['service', 'billing'], 'applies only'],
  ] as const)('refuses --page --api for %j', async (manifest, args, message) => {
    const h = project(manifest);
    expect(await h.run([...args, '--page', '--api'])).toBe(2);
    expect(h.err.text()).toContain(message);
    expect(h.fs.writes).toEqual([]);
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

describe('page test support', () => {
  it('writes a managed pages.ts only with a page', () => {
    const paths = (options: { page?: boolean; api?: boolean }) =>
      generateFullStackModule(names, { runtime: 'node', ...options })
        .filter((file) => file.path === PAGES_SUPPORT_PATH)
        .map((file) => file.managed);
    expect(paths({})).toEqual([]);
    expect(paths({ page: true })).toEqual([true]);
    expect(paths({ page: true, api: true })).toEqual([true]);
    const api = generateFullStackModule(names, { runtime: 'node' });
    expect(byPath(api, 'src/modules/articles/articles.e2e.test.ts')).not.toContain('pages.ts');
  });

  it('posts a CSRF form and decodes loader data with React Router', () => {
    const pages = renderPagesSupport();
    expect(pages).toContain(
      "import { UNSAFE_decodeViaTurboStream as decodeViaTurboStream } from 'react-router';",
    );
    expect(pages).toContain('body: new URLSearchParams({ ...fields, _csrf: session.token })');
    expect(pages).toContain("redirect: 'manual'");
    expect(pages).toContain("'.data?_routes=' + encodeURIComponent(routeId)");
    expect(pages).toContain('await decodeViaTurboStream(response.body, globalThis)');
    expect(pages).toContain("!('data' in route)");
  });
});
