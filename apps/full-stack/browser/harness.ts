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

/**
 * Environment variables Playwright reads to locate its browser cache. Clearing any of them would
 * make the harness resolve a different cache than the one the browser was installed into.
 */
export const CACHE_LOCATION_VARIABLES = [
  'PLAYWRIGHT_BROWSERS_PATH',
  'XDG_CACHE_HOME',
  'LOCALAPPDATA',
] as const;

/**
 * Derives the browser cache from the executable path Playwright itself resolved, so the gate never
 * restates Playwright's per-platform cache rules. The cache is the directory holding the
 * `chromium-<revision>` (or `chromium_headless_shell-<revision>`) install: the LAST segment of
 * exactly that shape, so a cache path containing e.g. `chromium-cache` is not mistaken for it.
 */
export function browserCacheDir(executable: string): string {
  const separator = executable.includes('\\') && !executable.includes('/') ? '\\' : '/';
  const segments = executable.split(separator);
  const install = segments.findLastIndex((segment) =>
    /^chromium(?:_headless_shell)?-\d+$/.test(segment)
  );
  if (install <= 0) {
    throw new Error(`Cannot locate the Playwright browser cache in '${executable}'.`);
  }
  return segments.slice(0, install).join(separator);
}

/** The diagnostic for an installed-or-not browser the gate is not permitted to inspect. */
export function unreadableCacheMessage(cache: string): string {
  return `The Playwright browser cache '${cache}' is outside this gate's read permission, so ` +
    `Chromium's presence cannot be decided. Run the harness with --allow-read=.,${cache},` +
    `/etc/os-release,/etc/lsb-release (the deno.json task grants only the Linux and macOS ` +
    `default caches).`;
}

if (import.meta.main) {
  // Dependency code and child builds receive only the local harness environment.
  const retained: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'CI', ...CACHE_LOCATION_VARIABLES]) {
    const value = Deno.env.get(name);
    if (value !== undefined) retained[name] = value;
  }
  for (const name of Object.keys(Deno.env.toObject())) Deno.env.delete(name);
  for (const [name, value] of Object.entries(retained)) Deno.env.set(name, value);
  // Playwright's pinned WSL detector otherwise asks for all of /proc.
  Deno.env.set('__IS_WSL_TEST__', '1');
  const { chromium } = await import('npm:playwright@1.63.0');
  const executable = chromium.executablePath();
  const cache = browserCacheDir(executable);
  // A failed stat on an unreadable path would otherwise report an installed browser as missing.
  if ((await Deno.permissions.query({ name: 'read', path: cache })).state !== 'granted') {
    console.error(unreadableCacheMessage(cache));
    Deno.exit(1);
  }
  const code = await browserGateCode(
    executable,
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
      '--no-prompt',
      `--allow-read=.,${cache},/etc/os-release,/etc/lsb-release`,
      '--allow-write=.tmp/browser,apps/full-stack/build',
      '--allow-net=127.0.0.1',
      '--allow-env',
      '--allow-sys=hostname,cpus,osRelease,uid,gid,homedir',
      `--allow-run=${Deno.execPath()},${executable}`,
      '--config',
      'apps/full-stack/deno.json',
      'apps/full-stack/browser/full-stack.browser.test.ts',
    ],
    cwd: root,
    clearEnv: true,
    env: { ...retained, __IS_WSL_TEST__: '1', TMPDIR: scratch },
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  Deno.exit(result.code);
}
