/** Builds and boots the three runtime view scaffolds against real Chromium. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../../packages/cli/src/cli.ts';
import {
  REPO_ROOT,
  withGeneratedServer,
} from '../../../packages/cli/test/fixtures/generated-project.ts';
import {
  runIn,
  startOverlay,
  withNodeServer,
  type RegistryOverlay,
} from '../../../packages/cli/test/fixtures/node-project.ts';
import { browserTempDir, runtimeGateCode } from './harness.ts';
import {
  assertEarlyTheme,
  assertFixedShell,
  assertPrimaryButton,
  assertThemeCycle,
  recordEarlyTheme,
} from './shell.ts';

let scratch: string;
let overlay: RegistryOverlay;
let browser: Browser;
beforeAll(async () => {
  await mkdir(`${REPO_ROOT}/.tmp/browser`, { recursive: true });
  scratch = await mkdtemp(`${REPO_ROOT}/.tmp/browser/views-`);
  overlay = await startOverlay();
  browser = await chromium.launch({
    channel: 'chromium',
    env: { ...process.env, TMPDIR: browserTempDir(process.cwd(), REPO_ROOT) },
  });
}, 900_000);
afterAll(async () => {
  await browser?.close();
  await overlay?.close();
  if (scratch) await rm(scratch, { recursive: true });
});

for (const target of ['node', 'bun', 'deno'] as const) {
  let present = true;
  if (target !== 'node') {
    try {
      present = (await runIn(REPO_ROOT, target, ['--version'])).code === 0;
    } catch {
      present = false;
    }
    runtimeGateCode(target, present, process.env['CI'] === 'true');
  }
  describe.skipIf(!present)(`${target} styled view scaffold`, () => {
    it(
      'has a fixed shell, render-blocking CSS, early theme and working preference toggle',
      { timeout: 900_000 },
      async () => {
        const runtime = createNodeRuntimeServices();
        const messages: string[] = [];
        const cli = (args: string[]) =>
          runCli(args, {
            fs: runtime.fs!,
            cwd: scratch,
            now: () => runtime.now(),
            log: (line) => messages.push(line),
            error: (line) => messages.push(line),
          });
        expect(
          await cli(['new', target, '--runtime', target, '--template', 'rest']),
          messages.join('\n'),
        ).toBe(0);
        const project = `${scratch}/${target}`;
        expect(await cli(['add', 'view', '--dir', project]), messages.join('\n')).toBe(0);
        const command = target === 'node' ? 'npm' : target;
        for (const args of [['install'], [target === 'deno' ? 'task' : 'run', 'build']]) {
          const result = await runIn(project, command, args, overlay);
          expect(result.code, result.output).toBe(0);
        }
        const drive = async (origin: string) => {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.emulateMedia({ colorScheme: 'light' });
            await recordEarlyTheme(page, 'dark');
            const response = await page.goto(`${origin}/ui`, { waitUntil: 'networkidle' });
            expect(response!.status()).toBe(200);
            await assertEarlyTheme(page, 'dark');
            const html = await response!.text();
            expect(
              await page.locator('head link[rel="stylesheet"][href="/assets/app.css"]').count(),
            ).toBe(1);
            const stylesheet = html.indexOf('href="/assets/app.css"');
            expect(stylesheet).toBeGreaterThanOrEqual(0);
            expect(html.indexOf('<body')).toBeGreaterThan(stylesheet);
            await assertPrimaryButton(page);
            await assertFixedShell(page);
            // A new page with no init script lets reload observe the toggle's own storage writes.
            await page.close();
            await context.clearCookies();
            const cycling = await context.newPage();
            await cycling.goto(`${origin}/ui`);
            await cycling.evaluate(() => localStorage.removeItem('theme'));
            await assertThemeCycle(cycling, `${origin}/ui`);
            const system = await context.newPage();
            await system.emulateMedia({ colorScheme: 'dark' });
            await recordEarlyTheme(system, null);
            await system.goto(`${origin}/ui`, { waitUntil: 'domcontentloaded' });
            await assertEarlyTheme(system, 'dark');
          } finally {
            await context.close();
          }
        };
        if (target === 'deno') await withGeneratedServer(project, drive);
        else await withNodeServer(project, drive, { TMPDIR: browserTempDir(project, REPO_ROOT) });
      },
    );
  });
}
