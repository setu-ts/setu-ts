/** Contract tests for the app files emitted by the full-stack template. */
import { describe, expect, it } from 'vitest';

import {
  FULL_STACK_APP_FILES,
  FULL_STACK_README_SECTION,
} from '../../../src/templates/full-stack-app-files.ts';
import { fullStackModuleFiles } from '../../../src/templates/full-stack-module-files.ts';
import { cliInvocation } from '../../../src/templates/project-files.ts';

function contentsOf(path: string): string {
  const file = FULL_STACK_APP_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`Full-stack app files emit no ${path}`);
  return file.contents;
}

describe('full-stack app files', () => {
  for (const runtime of ['node', 'deno', 'bun', 'cloudflare-workers'] as const) {
    it(`aligns the README table around the pinned ${runtime} command`, () => {
      const invocation = cliInvocation(runtime);
      const section = FULL_STACK_README_SECTION(invocation, runtime);
      const table = section.split('\n').filter((line) => line.startsWith('|'));
      expect(table).toHaveLength(4);
      const widths = table.map((line) => line.split('|').at(-2)!.length);
      expect(new Set(widths).size).toBe(1);
      expect(section).toContain(`${invocation} generate middleware <name>`);
      // V11-19: the Workers deployment notes appear on Workers and nowhere else.
      expect(section.includes('## Cloudflare Workers build')).toBe(
        runtime === 'cloudflare-workers',
      );
      expect(section).not.toContain('wrangler secret put');
      if (runtime === 'cloudflare-workers') {
        expect(section).toContain('builds the client and server');
        expect(section).toContain('Everything in `build/client`');
      }
      // Review finding 2: Workers has no dev.ts, PORT or VITE_PORT.
      expect(section.includes('## Development ports')).toBe(runtime !== 'cloudflare-workers');
      expect(section).not.toMatch(/\n\n\n/);
    });
  }

  it('explains modules, the ~kernel boundary and calling the API (X91-5)', () => {
    const section = FULL_STACK_README_SECTION('npx setu', 'node');
    expect(section).toContain('## Modules and pages');
    expect(section).toContain('getService(context, PRODUCTS)');
    expect(section).toContain('setu.E017');
    expect(section).toContain(
      '`npx setu generate module <name>` (`/api/<name>` routes), or with `--page`',
    );
    expect(section).toContain('add `--api` to `--page` for both');
    expect(section).toContain('## Calling the API');
    expect(section).toContain('The generated `/api` routes are not behind sign-in');
    expect(section).toContain('`x-csrf-token`');
    expect(section).toContain('a plain POST answers 403 by\ndesign');
    expect(section).toContain('`VITE_PORT`');
  });

  it('documents who renders a route-middleware refusal', () => {
    const middleware = contentsOf('app/server/require-user.server.ts');

    expect(middleware).toContain("rendered by React Router's route error boundary");
    expect(middleware).toContain('API callers');
  });

  it('writes products through the page action, not the API', () => {
    const page = contentsOf('app/routes/_app/products._index.tsx');
    expect(page).toContain('export async function action(');
    expect(page).toContain(
      "import { getService, pageAction } from '@setu-ts/react-router-plugin';",
    );
    expect(page).toContain("products.parse({ name: form.get('name'), price: form.get('price') })");
    expect(page).toContain("pageAction('create', () => products.create(input))");
    expect(page).toContain("redirect('/products', 303)");
    expect(page).toContain("<Form method='post'");
    expect(page).toContain("<input type='hidden' name='_csrf' value={csrfToken} />");
    expect(page).toContain('csrfToken: getCsrfToken(context)');
    expect(page).not.toContain("/api/products'");
    expect(page).not.toContain('fetch(');
  });

  it('signs out through an action-only route the layout posts to', () => {
    const logout = contentsOf('app/routes/_app/logout.tsx');
    expect(logout).toContain('export function action(');
    expect(logout).not.toContain('export default');
    expect(logout).not.toContain('export function loader');
    expect(logout.indexOf('session.clear();')).toBeLessThan(
      logout.indexOf('session.regenerate();'),
    );
    expect(logout).toContain("redirect('/login', 303)");
    const layout = contentsOf('app/components/layouts/AppLayout.tsx');
    expect(layout).toContain("<Form method='post' action='/logout'>");
    expect(layout).toContain("<input type='hidden' name='_csrf' value={csrfToken} />");
    expect(layout).toContain('csrfToken: getCsrfToken(context)');
  });

  it('gives the products service parse and create with a duplicate refusal', () => {
    const service = fullStackModuleFiles().find((file) =>
      file.path.endsWith('products.service.ts'),
    )!.contents;
    expect(service).toContain(
      'parse(value: { readonly name?: unknown; readonly price?: unknown })',
    );
    expect(service).toContain('create(input: ProductInput): Promise<Product>;');
    expect(service).toContain("import { conflict } from '@setu-ts/exceptions';");
    expect(service).toContain('Promise.reject(conflict(');
    const controller = fullStackModuleFiles().find((file) =>
      file.path.endsWith('products.controller.ts'),
    )!.contents;
    expect(controller).toContain('For callers outside the app');
  });
});
