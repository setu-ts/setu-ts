/** Real Chromium checks for the example and an unmodified fresh full-stack scaffold. */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { run } from '../../../scripts/lib/run.ts';
import { browserTempDir } from './harness.ts';
import {
  assertEarlyTheme,
  assertFixedShell,
  assertPrimaryButton,
  assertThemeCycle,
  recordEarlyTheme,
} from './shell.ts';
import { type Browser, chromium, type Page } from 'playwright';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../../packages/cli/src/cli.ts';
import { REPO_ROOT } from '../../../packages/cli/test/fixtures/generated-project.ts';
import {
  startOverlay,
  npmInstall,
  withNodeServer,
  type RegistryOverlay,
} from '../../../packages/cli/test/fixtures/node-project.ts';

let overlay: RegistryOverlay;

let browser: Browser;
let scratch: string;
let scaffold: string;
const email = 'browser@example.test';

async function command(project: string, args: string[]): Promise<void> {
  const result = await run('pnpm', args, { cwd: project });
  expect(result.code, result.stdout + result.stderr).toBe(0);
}

beforeAll(async () => {
  await mkdir(`${REPO_ROOT}/.tmp/browser`, { recursive: true });
  scratch = await mkdtemp(`${REPO_ROOT}/.tmp/browser/suite-`);
  overlay = await startOverlay();
  const runtime = createNodeRuntimeServices();
  const messages: string[] = [];
  expect(
    await runCli(['new', 'shop', '--template', 'full-stack', '--runtime', 'node'], {
      fs: runtime.fs!,
      cwd: scratch,
      now: () => runtime.now(),
      log: (line) => messages.push(line),
      error: (line) => messages.push(line),
    }),
    messages.join('\n'),
  ).toBe(0);
  scaffold = `${scratch}/shop`;
  const installed = await npmInstall(scaffold, overlay);
  expect(installed.code, installed.output).toBe(0);
  await command(scaffold, ['run', 'build']);
  await command(`${REPO_ROOT}/apps/full-stack`, ['run', 'build']);
  // The workspace scratch directory above also holds Chromium's singleton socket.
  // Use the bundled Chromium executable checked by harness.ts, not a system browser.
  browser = await chromium.launch({
    channel: 'chromium',
    // Linux socket paths are bounded to 108 bytes. A relative temp path keeps
    // Chromium's singleton socket inside this workspace even in deep worktrees.
    env: { ...process.env, TMPDIR: browserTempDir(process.cwd(), REPO_ROOT) },
  });
}, 900_000);

afterAll(async () => {
  await browser?.close();
  await overlay?.close();
  if (scratch !== undefined) await rm(scratch, { recursive: true });
});

/** A new cookie jar for each check, driving the real application's generated entry. */
async function drive(
  project: string,
  check: (page: Page, origin: string) => Promise<void>,
  javaScriptEnabled = true,
): Promise<void> {
  await withNodeServer(
    project,
    async (origin) => {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        await check(page, origin);
      } finally {
        await context.close();
      }
    },
    { TMPDIR: browserTempDir(project, REPO_ROOT) },
  );
}

/** Sign in through the real browser form before probing authenticated SSR. */
async function signIn(page: Page, origin: string): Promise<void> {
  await loginForm(page, origin);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/products');
  await page.getByRole('heading', { name: /Products/ }).waitFor();
}

/** Route state changes must preserve the document; SSR alone cannot pass this assertion. */
async function clientTransition(
  page: Page,
  action: () => Promise<unknown>,
  pathname: string,
): Promise<void> {
  const before = await page.evaluate(() => performance.timeOrigin);
  await action();
  await page.waitForURL(`**${pathname}`);
  expect(
    await page.evaluate(() => performance.timeOrigin),
    'client transition caused a document reload',
  ).toBe(before);
}

/** Every emitted modulepreload, script and stylesheet reference must be delivered. */
async function referencedAssets(page: Page, origin: string): Promise<string[]> {
  const assets = new Set<string>();
  for (const path of ['/', '/login', '/products']) {
    const response = await page.goto(`${origin}${path}`);
    expect(response).not.toBeNull();
    const html = await response!.text();
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)) {
      assets.add(match[1]!);
    }
  }
  return [...assets].sort();
}

async function assertAssets(page: Page, origin: string, assets: readonly string[]): Promise<void> {
  for (const path of assets) {
    const response = await page.request.get(`${origin}${path}`);
    expect(response.status(), `missing referenced asset ${path}`).toBe(200);
    expect(response.headers()['content-type'], `wrong content type for ${path}`).toMatch(
      path.endsWith('.css') ? /text\/css/ : /(?:text|application)\/javascript/,
    );
  }
}

async function loginForm(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/login`, { waitUntil: 'networkidle' });
  await page.locator('[name=email]').fill(email);
  await page.locator('[name=password]').fill('example');
}

for (const target of ['example', 'scaffold'] as const) {
  describe(`full-stack browser — ${target}`, () => {
    const project = () => (target === 'example' ? `${REPO_ROOT}/apps/full-stack` : scaffold);

    it('renders the landing page through SSR', async () => {
      await drive(project(), async (page, origin) => {
        const response = await page.request.get(origin);
        expect(response.status()).toBe(200);
        expect(await response.text()).toContain('You are not signed in.');
      });
    });
    it('renders the login form and CSRF token through SSR', async () => {
      await drive(project(), async (page, origin) => {
        const response = await page.request.get(`${origin}/login`);
        expect(response.status()).toBe(200);
        expect(await response.text()).toContain('name="_csrf"');
      });
    });
    it('renders signed-in products through SSR', async () => {
      await drive(project(), async (page, origin) => {
        await signIn(page, origin);
        const response = await page.goto(`${origin}/products`);
        expect(response!.status()).toBe(200);
        expect(await response!.text()).toContain('Products (');
      });
    });
    it('hydrates route state and changes pages without reloading the document', async () => {
      await drive(project(), async (page, origin) => {
        await page.goto(origin, { waitUntil: 'networkidle' });
        await clientTransition(
          page,
          () => page.getByRole('link', { name: 'Sign in', exact: true }).click(),
          '/login',
        );
        // The URL can change before React commits the new route, so wait for
        // the form rather than counting at once (a CI flake on PR #465).
        await page.locator('form').first().waitFor();
        expect(await page.locator('form').count()).toBe(1);
      });
    });
    it('serves all referenced assets with the correct content type', async () => {
      await drive(project(), async (page, origin) => {
        await signIn(page, origin);
        const assets = await referencedAssets(page, origin);
        expect(
          assets.length,
          'the full route set must exercise at least the eight original assets',
        ).toBeGreaterThanOrEqual(8);
        await assertAssets(page, origin, assets);
      });
    });
    it('submits Form as a client transition', async () => {
      await drive(project(), async (page, origin) => {
        await loginForm(page, origin);
        await clientTransition(
          page,
          () => page.getByRole('button', { name: 'Sign in' }).click(),
          '/products',
        );
      });
    });
    it('keeps the session cookie HttpOnly', async () => {
      await drive(project(), async (page, origin) => {
        await signIn(page, origin);
        const cookies = await page.context().cookies();
        expect(cookies.length).toBeGreaterThan(0);
        expect(cookies.every((cookie) => cookie.httpOnly)).toBe(true);
        await page.goto(origin);
        expect(await page.evaluate(() => document.cookie)).toBe('');
      });
    });
    it('degrades to a real POST and 302 with JavaScript disabled', async () => {
      await drive(
        project(),
        async (page, origin) => {
          await loginForm(page, origin);
          const posted = page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/login',
          );
          await page.getByRole('button', { name: 'Sign in' }).click();
          const response = await posted;
          expect(response.status()).toBe(302);
          await page.waitForURL('**/products');
        },
        false,
      );
    });
    it('detects missing hydration when the client entry is aborted while SSR still renders', async () => {
      await drive(project(), async (page, origin) => {
        await page.route('**/assets/entry.client-*.js', (route) => route.abort());
        await page.goto(origin, { waitUntil: 'networkidle' });
        expect(await page.locator('body').textContent()).toContain('You are not signed in.');
        await expect(
          clientTransition(
            page,
            () => page.getByRole('link', { name: 'Sign in', exact: true }).click(),
            '/login',
          ),
        ).rejects.toThrow('document reload');
      });
    });
    it('detects a document navigation on Form when the client entry is aborted', async () => {
      await drive(project(), async (page, origin) => {
        await page.route('**/assets/entry.client-*.js', (route) => route.abort());
        await loginForm(page, origin);
        await expect(
          clientTransition(
            page,
            () => page.getByRole('button', { name: 'Sign in' }).click(),
            '/products',
          ),
        ).rejects.toThrow('document reload');
      });
    });
    it('names a referenced bundle that is missing from the served build', async () => {
      await drive(project(), async (page, origin) => {
        const assets = await referencedAssets(page, origin);
        const missing = assets.find((path) => path.includes('entry.client-'))!;
        expect(missing).toBeDefined();
        const path = `${project()}/build/client${missing}`;
        await rename(path, `${path}.missing`);
        try {
          expect((await page.request.get(origin)).status()).toBe(200);
          await expect(assertAssets(page, origin, assets)).rejects.toThrow(
            `missing referenced asset ${missing}`,
          );
        } finally {
          await rename(`${path}.missing`, path);
        }
      });
    });
  });
}

describe('full-stack scaffold shell and theme (M123)', () => {
  it('keeps the shell fixed on desktop and mobile, and resets content on client navigation', async () => {
    await drive(scaffold, async (page, origin) => {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await assertFixedShell(page);
      await page.addStyleTag({ content: '[data-slot=card] { min-height: 6000px; }' });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator('[data-shell=content]').evaluate((element) => {
        element.scrollTop = 3000;
      });
      await clientTransition(
        page,
        () =>
          page
            .getByRole('navigation', { name: 'Application navigation' })
            .getByRole('link', { name: 'Products', exact: true })
            .click(),
        '/login',
      );
      await page.locator('form').waitFor();
      // Sign in, then navigate from the long landing page inside the SAME AppLayout.
      await page.locator('[name=email]').fill(email);
      await page.locator('[name=password]').fill('example');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/products');
      await page.goto(origin, { waitUntil: 'networkidle' });
      await assertFixedShell(page);
      await page.addStyleTag({ content: '[data-slot=card] { min-height: 6000px; }' });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator('[data-shell=content]').evaluate((element) => {
        element.scrollTop = 3000;
      });
      await clientTransition(
        page,
        () =>
          page
            .getByRole('navigation', { name: 'Application navigation' })
            .getByRole('link', { name: 'Products', exact: true })
            .click(),
        '/products',
      );
      await page.getByRole('heading', { name: /Products/ }).waitFor();
      expect(
        await page.locator('[data-shell=content]').evaluate((element) => element.scrollTop),
      ).toBe(0);
    });
  });
  it('applies stored dark at DOMContentLoaded and resolves the primary button token', async () => {
    await drive(scaffold, async (page, origin) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await recordEarlyTheme(page, 'dark');
      await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
      await assertEarlyTheme(page, 'dark');
      await assertPrimaryButton(page);
    });
  });
  it('cycles and persists the theme, and follows a live system preference', async () => {
    await drive(scaffold, async (page, origin) => {
      await assertThemeCycle(page, origin);
    });
  });
  it('uses dark system mode before paint with no stored preference', async () => {
    await drive(scaffold, async (page, origin) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await recordEarlyTheme(page, null);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await assertEarlyTheme(page, 'dark');
    });
  });
  it('renders light with JavaScript disabled', async () => {
    await drive(
      scaffold,
      async (page, origin) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(origin);
        expect(
          await page.locator('html').evaluate((element) => element.classList.contains('dark')),
        ).toBe(false);
      },
      false,
    );
  });
});
