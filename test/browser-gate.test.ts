/** Browser skip policy is enforced without requiring a browser in ordinary gates. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  BROWSER_INSTALL_COMMAND,
  browserAvailabilityCode,
  browserGateCode,
  PLAYWRIGHT_VERSION,
} from '../apps/full-stack/browser/harness.ts';

describe('dedicated browser gate', () => {
  it('resolves present and absent executables with no browser import', async () => {
    expect(await browserGateCode('/browser', false, (path) => Promise.resolve(path === '/browser')))
      .toBe(0);
    expect(await browserGateCode('/missing', false, () => Promise.resolve(false))).toBe(77);
    expect(await browserGateCode('/missing', true, () => Promise.resolve(false))).toBe(1);
    expect(browserAvailabilityCode(true, true)).toBe(0);
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
