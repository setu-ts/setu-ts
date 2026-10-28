/* eslint-disable no-console -- gate diagnostics belong on the command line. */
/** Dedicated browser prerequisite gate. Ordinary tests never launch Chromium. */
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { run } from '../../../scripts/lib/run.ts';

/** Pin shared with CI's browser installation step. */
export const PLAYWRIGHT_VERSION = '1.63.0';
/** Workspace-relative scratch directory shared by browser processes. */
export const BROWSER_TEMP_DIRECTORY = '.tmp/browser';

/**
 * Keeps Unix socket names short without moving scratch outside the workspace.
 * @param project - The child process working directory
 * @param root - The workspace root
 * @returns A relative path to the workspace's browser scratch directory
 */
export function browserTempDir(project: string, root: string): string {
  return relative(project, resolve(root, BROWSER_TEMP_DIRECTORY)) || '.';
}
/** Install only Chromium using the pinned app dependency. */
export const BROWSER_INSTALL_COMMAND =
  'pnpm --filter setu-ts-example-full-stack exec playwright install chromium';

/** Missing browsers may skip locally, but are failures in CI regardless of ALLOW_SKIP. */
export function browserAvailabilityCode(present: boolean, ci: boolean): 0 | 1 | 77 {
  return present ? 0 : ci ? 1 : 77;
}

/** Missing named runtimes skip locally, and fail under CI, just like Chromium. */
export function runtimeGateCode(runtime: 'bun' | 'deno', present: boolean, ci: boolean): 0 | 77 {
  const code = browserAvailabilityCode(present, ci);
  if (code === 1)
    throw new Error(`${runtime} is unavailable in the browser gate (CI requires it).`);
  if (code === 77) console.error(`SKIP — ${runtime} view scaffold: missing tool ${runtime}`);
  return code;
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
    /^chromium(?:_headless_shell)?-\d+$/.test(segment),
  );
  if (install <= 0) {
    throw new Error(`Cannot locate the Playwright browser cache in '${executable}'.`);
  }
  return segments.slice(0, install).join(separator);
}

if (import.meta.main) {
  // Dependency code and child builds receive only the local harness environment.
  const retained: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'CI', ...CACHE_LOCATION_VARIABLES]) {
    const value = process.env[name];
    if (value !== undefined) retained[name] = value;
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [name, value] of Object.entries(retained)) process.env[name] = value;
  // Playwright's pinned WSL detector otherwise asks for all of /proc.
  process.env['__IS_WSL_TEST__'] = '1';
  const { chromium } = await import('playwright');
  const executable = chromium.executablePath();
  const code = await browserGateCode(executable, process.env['CI'] === 'true', async (path) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  });
  if (code !== 0) {
    console.error(`Chromium is unavailable. Install it with: ${BROWSER_INSTALL_COMMAND}`);
    process.exit(code);
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const scratch = `${root}.tmp/browser`;
  await mkdir(scratch, { recursive: true });
  const result = await run(
    'pnpm',
    [
      '--filter',
      'setu-ts-example-full-stack',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.browser.config.ts',
    ],
    {
      cwd: root,
      env: { ...retained, __IS_WSL_TEST__: '1', TMPDIR: scratch },
      inherit: true,
    },
  );
  process.exitCode = result.code;
}
