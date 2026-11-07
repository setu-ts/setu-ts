/**
 * M130 §7 generated-output gate, on Node: a full-stack scaffold, `setu g module
 * articles --page`, then the project's own check, build and generated tests,
 * and a boot that reads the module's data back through the page and the API.
 *
 * Every step runs the GENERATED project with its own scripts; nothing here is
 * hand-wired, which is the point: a page uses a module's service with no hand
 * edit to `setu.config.ts` (the ROADMAP gate).
 *
 * @module
 */
import * as nodeFs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { createCommandRunner } from '../../src/utils/run-command.ts';
import { npmInstall, npmRun, startOverlay, withNodeServer } from '../fixtures/node-project.ts';

/** Cookie header from a response's Set-Cookie lines. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';', 1)[0])
    .join('; ');
}

it(
  'g module --page: check, build, generated tests, and page + API read back one service',
  { timeout: 900_000 },
  async () => {
    const root = await tempDir({ prefix: 'full-stack-modules-' });
    const runtime = createNodeRuntimeServices();
    const output: string[] = [];
    const cli = (args: readonly string[]) =>
      runCli(args, {
        fs: runtime.fs!,
        cwd: root,
        now: () => runtime.now(),
        log: (line) => output.push(line),
        error: (line) => output.push(line),
        runCommand: createCommandRunner(),
      });
    const overlay = await startOverlay();
    try {
      expect(
        await cli(['new', 'shop', '--template', 'full-stack', '--runtime', 'node']),
        output.join('\n'),
      ).toBe(0);
      const project = `${root}/shop`;
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);

      // (6) Baseline: the page uses the module's service with NO edit to setu.config.ts.
      const configBefore = await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8');
      // (1) The module and its page, exactly as a developer generates them.
      expect(
        await cli(['g', 'module', 'articles', '--page', '--dir', project]),
        output.join('\n'),
      ).toBe(0);
      expect(await nodeFs.readFile(`${project}/setu.config.ts`, 'utf8')).toBe(configBefore);

      // The project's own gates: setu check is part of `check`.
      const checked = await npmRun(project, 'check');
      expect(checked.code, checked.output).toBe(0);
      const built = await npmRun(project, 'build');
      expect(built.code, built.output).toBe(0);
      // (1, X91-2) The generated module tests pass with no hand edit: they sign a
      // session and send its CSRF token.
      const unit = await npmRun(project, 'test');
      expect(unit.code, unit.output).toBe(0);
      const e2e = await npmRun(project, 'test:e2e');
      expect(e2e.code, e2e.output).toBe(0);

      const { result, output: serverOutput } = await withNodeServer(project, async (origin) => {
        // Sign in through /login, keeping the session cookie and CSRF token.
        const loginPage = await fetch(`${origin}/login`);
        const token = /name="_csrf"\s+value="([^"]+)"/.exec(await loginPage.text())?.[1] ?? '';
        const submitted = await fetch(`${origin}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            cookie: cookiesOf(loginPage),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ _csrf: token, email: 'ada@example.com', password: 'x' }),
        });
        await submitted.body?.cancel();
        const cookie = cookiesOf(submitted);

        // (O3) An unsafe /api request without the token is refused; with it, created.
        const refused = await fetch(`${origin}/api/articles`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Refused' }),
        });
        await refused.body?.cancel();
        // A bearer header without an auth arm is not an exemption.
        const bearer = await fetch(`${origin}/api/articles`, {
          method: 'POST',
          headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Bearer' }),
        });
        await bearer.body?.cancel();
        // (2) Seed through the API with the session cookie and CSRF token.
        const seeded = await fetch(`${origin}/api/articles`, {
          method: 'POST',
          headers: { cookie, 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Hello from the module' }),
        });
        const record = (await seeded.json()) as { id: string; name: string };

        // (2) The page lists what the module's service holds.
        const page = await fetch(`${origin}/articles`, { headers: { cookie } });
        const html = await page.text();
        // (3) The API returns the same list.
        const api = (await (await fetch(`${origin}/api/articles`)).json()) as {
          items: { id: string; name: string }[];
        };
        // The template's own module: page and API agree too.
        const products = await fetch(`${origin}/products`, { headers: { cookie } });
        const productsHtml = await products.text();
        const productsApi = (await (await fetch(`${origin}/api/products`)).json()) as {
          items: { name: string }[];
        };
        // (4) The document lists the module APIs and no page, asset or dev-proxy route.
        const spec = (await (await fetch(`${origin}/openapi.json`)).json()) as {
          paths: Record<string, unknown>;
        };
        // (5) Ten unknown URLs: 404, and no stack trace on stderr.
        const unknown: number[] = [];
        for (let i = 0; i < 10; i++) {
          const response = await fetch(`${origin}/no-such-page-${i}`);
          await response.text();
          unknown.push(response.status);
        }
        return {
          submitted: submitted.status,
          refused: refused.status,
          bearer: bearer.status,
          seeded: seeded.status,
          record,
          page: { status: page.status, html },
          api,
          products: { status: products.status, html: productsHtml },
          productsApi,
          paths: Object.keys(spec.paths),
          unknown,
        };
      });

      expect(result.submitted, serverOutput).toBe(302);
      expect(result.refused).toBe(403);
      expect(result.bearer).toBe(403);
      expect(result.seeded).toBe(201);
      expect(result.page.status).toBe(200);
      expect(result.page.html).toContain('Hello from the module');
      expect(result.api.items).toEqual([result.record]);
      expect(result.products.status).toBe(200);
      for (const product of result.productsApi.items)
        expect(result.products.html).toContain(product.name);
      expect(result.paths).toContain('/api/articles');
      expect(result.paths).toContain('/api/products');
      for (const path of result.paths) {
        expect(path.startsWith('/assets'), path).toBe(false);
        expect(path.startsWith('/__vite'), path).toBe(false);
        expect(path === '/*' || path === '/{wildcard}', path).toBe(false);
      }
      expect(result.unknown).toEqual(Array.from({ length: 10 }, () => 404));
      expect(serverOutput).not.toMatch(/\n\s+at .+:\d+:\d+/);
      expect(serverOutput).not.toContain('No route matches URL');

      // (7) A page that imports kernel code by value fails setu check with setu.E017.
      const route = `${project}/app/routes/_app/articles._index.tsx`;
      const source = await nodeFs.readFile(route, 'utf8');
      await nodeFs.writeFile(
        route,
        `import { productsService } from '~kernel/modules/products/products.service.ts';\nvoid productsService;\n${source}`,
      );
      output.length = 0;
      expect(await cli(['check', '--dir', project])).toBe(1);
      expect(output.join('\n')).toContain(
        'setu.E017: app/routes/_app/articles._index.tsx:1 imports ~kernel/modules/products/products.service.ts by value',
      );
    } finally {
      await overlay.close();
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  },
);
