/** Checks every workspace application and runs its mandatory smoke script. */
import { isNotFound, run as runProcess } from './lib/run.ts';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workspaceApps } from './lib/workspace.ts';
/* eslint-disable no-console -- this CI script reports progress and skips. */

const SKIP_EXIT_CODE = 77;

interface AppConfig {
  readonly scripts?: Record<string, string>;
}

export type SmokeOutcome = 'passed' | 'skipped' | 'failed';

/** Classifies a smoke command result so skip handling is explicit and testable. */
export function classifySmokeExitCode(status: {
  code: number;
  success: boolean;
  signal?: string | null;
}): SmokeOutcome {
  if (status.code === SKIP_EXIT_CODE) return 'skipped';
  return status.success ? 'passed' : 'failed';
}

/**
 * Returns the skipped app names that are NOT in the allowlist.
 *
 * Pure: it does not know whether `ALLOW_SKIP` is set. Warn-only mode is the
 * CALLER's decision — `checkApps()` invokes this only once `ALLOW_SKIP` is
 * defined, so an unset variable never reaches here. An empty allowlist
 * therefore means "ALLOW_SKIP was set but listed nothing", under which every
 * skip is unexpected.
 */
export function unexpectedSkips(
  skipped: readonly string[],
  allowList: readonly string[],
): string[] {
  return skipped.filter((name) => !allowList.includes(name));
}

/**
 * Returns a human-readable message for a malformed application directory, or
 * `null` when the error should be rethrown.
 */
export function malformedAppDirMessage(directory: string, error: unknown): string | null {
  if (isNotFound(error)) {
    return `${directory}: missing package.json — malformed application directory`;
  }
  if (error instanceof SyntaxError) {
    return `${directory}: package.json is not valid JSON — malformed application directory`;
  }
  return null;
}

async function readAppConfig(path: string): Promise<AppConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as AppConfig;
}

async function run(
  command: readonly string[],
  cwd: string,
): Promise<{ code: number; success: boolean }> {
  // An app resolves @setu-ts/* to workspace source through its generated
  // tsconfig.json paths, which tsx applies itself; no import hook is added here.
  const result = await runProcess(command[0]!, command.slice(1), { cwd, inherit: true });
  return { code: result.code, success: result.code === 0 };
}

/** Check every app sequentially; injectable process runner exercises failure/skip wiring. */
export async function checkApps(
  root = '.',
  runCommand = run,
  allowRaw = process.env['ALLOW_SKIP'],
): Promise<boolean> {
  const enrolled = await workspaceApps(root);
  const appDirectories: string[] = [];
  for await (const entry of await readdir(`${root}/apps`, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      appDirectories.push(entry.name);
    }
  }
  appDirectories.sort();

  const skipped: string[] = [];
  let failed = false;
  for (const directory of appDirectories) {
    const cwd = resolve(root, `apps/${directory}`);

    let config: AppConfig;
    try {
      config = await readAppConfig(`${cwd}/package.json`);
    } catch (error) {
      const msg = malformedAppDirMessage(directory, error);
      if (msg !== null) {
        console.error(msg);
        failed = true;
        continue;
      }
      throw error;
    }

    if (!config.scripts?.start || !config.scripts.smoke) {
      console.error(`${directory}: every example must declare start and smoke tasks.`);
      failed = true;
      continue;
    }

    if (!enrolled.some((app) => app === `apps/${directory}`)) {
      console.error(`${directory}: package.json is not a workspace application.`);
      failed = true;
      continue;
    }

    console.log(`\n==> ${directory}: type checking`);
    const checked = await runCommand(['pnpm', 'run', 'check'], cwd);
    if (!checked.success) {
      failed = true;
      continue;
    }

    console.log(`==> ${directory}: smoke`);
    const smoked = await runCommand(['pnpm', 'run', 'smoke'], cwd);
    const outcome = classifySmokeExitCode(smoked);
    if (outcome === 'skipped') {
      skipped.push(directory);
      console.warn(`${directory}: smoke skipped (external prerequisite unavailable).`);
    } else if (outcome === 'failed') {
      failed = true;
    }

    if (config.scripts.test !== undefined) {
      console.log(`==> ${directory}: test`);
      const tested = await runCommand(['pnpm', 'run', 'test'], cwd);
      if (!tested.success) {
        failed = true;
      }
    }
  }

  // Report skipped summary
  if (skipped.length > 0) {
    console.warn(`Skipped: ${skipped.length} [${skipped.join(', ')}]`);
  }

  // ALLOW_SKIP enforcement
  if (allowRaw !== undefined) {
    const allowList = allowRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unexpected = unexpectedSkips(skipped, allowList);
    if (unexpected.length > 0) {
      console.error(`Unexpected skips (not in ALLOW_SKIP=${allowRaw}): ${unexpected.join(', ')}`);
      failed = true;
    }
  }

  return failed;
}

if (import.meta.main && (await checkApps())) {
  process.exitCode = 1;
}
