// deno-lint-ignore-file no-console -- gate diagnostics belong on the command line.
/** Dedicated browser prerequisite gate. Ordinary tests never launch Chromium. */

/** Pin shared with CI's browser installation step. */
export const PLAYWRIGHT_VERSION = '1.63.0';
/** Install only Chromium; Deno runs the npm CLI without a separate Node installation. */
export const BROWSER_INSTALL_COMMAND =
  `deno run -A npm:playwright@${PLAYWRIGHT_VERSION} install chromium`;

/** Missing browsers may skip locally, but are failures in CI regardless of ALLOW_SKIP. */
export function browserAvailabilityCode(present: boolean, ci: boolean): 0 | 1 | 77 {
  return present ? 0 : ci ? 1 : 77;
}

/** Resolves the exact Playwright executable using an injectable filesystem check. */
export async function browserGateCode(
  path: string,
  ci: boolean,
  exists: (path: string) => Promise<boolean>,
): Promise<0 | 1 | 77> {
  return browserAvailabilityCode(await exists(path), ci);
}

if (import.meta.main) {
  const { chromium } = await import('npm:playwright@1.63.0');
  const code = await browserGateCode(
    chromium.executablePath(),
    Deno.env.get('CI') === 'true',
    async (path) => {
      try {
        return (await Deno.stat(path)).isFile;
      } catch {
        return false;
      }
    },
  );
  if (code !== 0) {
    console.error(`Chromium is unavailable. Install it with: ${BROWSER_INSTALL_COMMAND}`);
    Deno.exit(code);
  }
  const root = new URL('../../../', import.meta.url).pathname;
  const scratch = `${root}.tmp/browser`;
  await Deno.mkdir(scratch, { recursive: true });
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '-A',
      '--config',
      'apps/full-stack/deno.json',
      'apps/full-stack/browser/full-stack.browser.test.ts',
    ],
    cwd: root,
    env: { TMPDIR: scratch },
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  Deno.exit(result.code);
}
