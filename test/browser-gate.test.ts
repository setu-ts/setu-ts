/** Browser skip policy is enforced without requiring a browser in ordinary gates. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  BROWSER_INSTALL_COMMAND,
  browserAvailabilityCode,
  browserCacheDir,
  browserGateCode,
  CACHE_LOCATION_VARIABLES,
  PLAYWRIGHT_VERSION,
  unreadableCacheMessage,
} from '../apps/full-stack/browser/harness.ts';

describe('dedicated browser gate', () => {
  it('resolves present and absent executables with no browser import', async () => {
    expect(await browserGateCode('/browser', false, (path) => Promise.resolve(path === '/browser')))
      .toBe(0);
    expect(await browserGateCode('/missing', false, () => Promise.resolve(false))).toBe(77);
    expect(await browserGateCode('/missing', true, () => Promise.resolve(false))).toBe(1);
    expect(browserAvailabilityCode(true, true)).toBe(0);
  });

  it('derives the cache from the executable Playwright resolved, on every platform layout', () => {
    expect(browserCacheDir('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'))
      .toBe('/opt/pw-browsers');
    expect(browserCacheDir('/xdg/ms-playwright/chromium_headless_shell-1243/x/headless_shell'))
      .toBe('/xdg/ms-playwright');
    expect(
      browserCacheDir(
        '/Users/a/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/' +
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    ).toBe('/Users/a/Library/Caches/ms-playwright');
    expect(
      browserCacheDir('C:\\Users\\a\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome.exe'),
    )
      .toBe('C:\\Users\\a\\AppData\\Local\\ms-playwright');
    expect(() => browserCacheDir('/usr/bin/chrome')).toThrow('Cannot locate');
    expect(() => browserCacheDir('chromium-1243/chrome')).toThrow('Cannot locate');
  });

  it('keeps every variable that moves the cache, and names an unreadable cache', async () => {
    expect([...CACHE_LOCATION_VARIABLES]).toEqual([
      'PLAYWRIGHT_BROWSERS_PATH',
      'XDG_CACHE_HOME',
      'LOCALAPPDATA',
    ]);
    expect(unreadableCacheMessage('/opt/pw')).toContain('--allow-read=.,/opt/pw,');
    const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
      tasks: Record<string, string>;
    };
    const app = JSON.parse(await Deno.readTextFile('apps/full-stack/deno.json')) as {
      tasks: Record<string, string>;
    };
    for (const task of [manifest.tasks['check:browser'], app.tasks['browser']]) {
      expect(task).toContain('$HOME/.cache/ms-playwright');
      expect(task).toContain('$HOME/Library/Caches/ms-playwright');
    }
  });

  it('pins CI and the local installer to the suite version, without enrolling browser skips', async () => {
    const ci = await Deno.readTextFile('.github/workflows/ci.yml');
    const suite = await Deno.readTextFile('apps/full-stack/browser/full-stack.browser.test.ts');
    const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
      tasks: Record<string, string>;
    };
    expect(manifest.tasks['check:browser']).not.toContain(' -A ');
    expect(manifest.tasks['check:browser']).toContain('--allow-run=deno');
    expect(ci).toContain(`playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`);
    expect(suite).toContain(`npm:playwright@${PLAYWRIGHT_VERSION}`);
    expect(BROWSER_INSTALL_COMMAND).toContain(`playwright@${PLAYWRIGHT_VERSION} install chromium`);
    expect(ci).not.toMatch(/ALLOW_SKIP:.*browser/);
  });
});
