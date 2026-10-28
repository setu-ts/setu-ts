/** Browser skip policy is enforced without requiring a browser in ordinary gates. */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import {
  BROWSER_INSTALL_COMMAND,
  BROWSER_TEMP_DIRECTORY,
  browserTempDir,
  browserAvailabilityCode,
  browserCacheDir,
  browserGateCode,
  CACHE_LOCATION_VARIABLES,
  PLAYWRIGHT_VERSION,
  runtimeGateCode,
} from '../apps/full-stack/browser/harness.ts';

describe('dedicated browser gate', () => {
  it('keeps temporary Unix socket names short and under the workspace root', () => {
    expect(BROWSER_TEMP_DIRECTORY).toBe('.tmp/browser');
    expect(browserTempDir('/workspace/apps/full-stack', '/workspace')).toBe('../../.tmp/browser');
    expect(browserTempDir('/workspace/.tmp/browser/run/shop', '/workspace')).toBe('../..');
    expect(browserTempDir('/workspace/.tmp/browser', '/workspace')).toBe('.');
  });

  it('names missing runtimes locally and refuses them under CI', () => {
    for (const runtime of ['bun', 'deno'] as const) {
      expect(runtimeGateCode(runtime, true, false)).toBe(0);
      expect(runtimeGateCode(runtime, true, true)).toBe(0);
      expect(runtimeGateCode(runtime, false, false)).toBe(77);
      expect(() => runtimeGateCode(runtime, false, true)).toThrow(runtime + ' is unavailable');
    }
  });

  it('resolves present and absent executables with no browser import', async () => {
    expect(
      await browserGateCode('/browser', false, (path) => Promise.resolve(path === '/browser')),
    ).toBe(0);
    expect(await browserGateCode('/missing', false, () => Promise.resolve(false))).toBe(77);
    expect(await browserGateCode('/missing', true, () => Promise.resolve(false))).toBe(1);
    expect(browserAvailabilityCode(true, true)).toBe(0);
  });

  it('derives the cache from the executable Playwright resolved, on every platform layout', () => {
    expect(browserCacheDir('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome')).toBe(
      '/opt/pw-browsers',
    );
    expect(
      browserCacheDir('/xdg/ms-playwright/chromium_headless_shell-1243/x/headless_shell'),
    ).toBe('/xdg/ms-playwright');
    expect(
      browserCacheDir(
        '/Users/a/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/' +
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    ).toBe('/Users/a/Library/Caches/ms-playwright');
    expect(
      browserCacheDir('C:\\Users\\a\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome.exe'),
    ).toBe('C:\\Users\\a\\AppData\\Local\\ms-playwright');
    // PR #415 review: a `chromium-` prefixed directory in the cache path is not the install.
    expect(
      browserCacheDir('/home/a/chromium-cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
    ).toBe('/home/a/chromium-cache/ms-playwright');
    expect(() => browserCacheDir('/usr/bin/chrome')).toThrow('Cannot locate');
    expect(() => browserCacheDir('chromium-1243/chrome')).toThrow('Cannot locate');
  });

  it('keeps every variable that moves the browser cache and launches a Node harness', async () => {
    expect([...CACHE_LOCATION_VARIABLES]).toEqual([
      'PLAYWRIGHT_BROWSERS_PATH',
      'XDG_CACHE_HOME',
      'LOCALAPPDATA',
    ]);
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    expect(manifest.scripts['check:browser']).toBe('node apps/full-stack/browser/harness.ts');
    const check = JSON.parse(await readFile('tsconfig.check.json', 'utf8'));
    expect(check.exclude).not.toContain('test/browser-gate.test.ts');
  });

  it('pins CI and the local installer to the suite version, without enrolling browser skips', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const suite = await readFile('apps/full-stack/browser/full-stack.browser.test.ts', 'utf8');
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['check:browser']).not.toContain(' -A ');
    expect(manifest.scripts['check:browser']).toMatch(/^node /);
    expect(ci).toContain(`playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`);
    expect(suite).toContain("from 'playwright'");
    const app = JSON.parse(await readFile('apps/full-stack/package.json', 'utf8'));
    expect(app.devDependencies.playwright).toBe(PLAYWRIGHT_VERSION);
    expect(BROWSER_INSTALL_COMMAND).toBe(
      'pnpm --filter setu-ts-example-full-stack exec playwright install chromium',
    );
    expect(ci).not.toMatch(/ALLOW_SKIP:.*browser/);
    const browserJob = ci.split('  browser:')[1]!.split('  fork-contribution-policy:')[0]!;
    expect(browserJob).toContain('oven-sh/setup-bun@v2');
    expect(browserJob).toContain('bun-version: 1.4.0');
    expect(browserJob).toContain('denoland/setup-deno@v2');
    expect(browserJob).toContain('deno-version: 2.9.5');
  });
});
