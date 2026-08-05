// deno-lint-ignore-file no-console -- this CI script reports progress and skips.
/** Checks every standalone application and runs its mandatory smoke task. */

const SKIP_EXIT_CODE = 77;

interface AppConfig {
  readonly tasks?: Record<string, string>;
}

export type SmokeOutcome = 'passed' | 'skipped' | 'failed';

/** Classifies a smoke command result so skip handling is explicit and testable. */
export function classifySmokeExitCode(
  status: Deno.CommandStatus,
): SmokeOutcome {
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
export function malformedAppDirMessage(
  directory: string,
  error: unknown,
): string | null {
  if (error instanceof Deno.errors.NotFound) {
    return `${directory}: missing deno.json — malformed application directory`;
  }
  if (error instanceof SyntaxError) {
    return `${directory}: deno.json is not valid JSON — malformed application directory`;
  }
  return null;
}

async function readAppConfig(path: string): Promise<AppConfig> {
  return JSON.parse(await Deno.readTextFile(path)) as AppConfig;
}

async function run(
  command: readonly string[],
  cwd: string,
): Promise<Deno.CommandStatus> {
  return await new Deno.Command(command[0], {
    args: [...command.slice(1)],
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
}

async function checkApps(): Promise<boolean> {
  const appDirectories: string[] = [];
  for await (const entry of Deno.readDir('apps')) {
    if (entry.isDirectory) {
      appDirectories.push(entry.name);
    }
  }
  appDirectories.sort();

  const skipped: string[] = [];
  let failed = false;
  for (const directory of appDirectories) {
    const cwd = `apps/${directory}`;

    let config: AppConfig;
    try {
      config = await readAppConfig(`${cwd}/deno.json`);
    } catch (error) {
      const msg = malformedAppDirMessage(directory, error);
      if (msg !== null) {
        console.error(msg);
        failed = true;
        continue;
      }
      throw error;
    }

    if (!config.tasks?.start || !config.tasks.smoke) {
      console.error(
        `${directory}: every example must declare start and smoke tasks.`,
      );
      failed = true;
      continue;
    }

    const entryPoints = ['main.ts', 'smoke.ts'];
    try {
      await Deno.stat(`${cwd}/worker.ts`);
      entryPoints.push('worker.ts');
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    console.log(`\n==> ${directory}: type checking`);
    const checked = await run(['deno', 'check', ...entryPoints], cwd);
    if (!checked.success) {
      failed = true;
      continue;
    }

    console.log(`==> ${directory}: smoke`);
    const smoked = await run(['deno', 'task', 'smoke'], cwd);
    const outcome = classifySmokeExitCode(smoked);
    if (outcome === 'skipped') {
      skipped.push(directory);
      console.warn(
        `${directory}: smoke skipped (external prerequisite unavailable).`,
      );
    } else if (outcome === 'failed') {
      failed = true;
    }

    if (config.tasks.test !== undefined) {
      console.log(`==> ${directory}: test`);
      const tested = await run(['deno', 'task', 'test'], cwd);
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
  const allowRaw = Deno.env.get('ALLOW_SKIP');
  if (allowRaw !== undefined) {
    const allowList = allowRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const unexpected = unexpectedSkips(skipped, allowList);
    if (unexpected.length > 0) {
      console.error(
        `Unexpected skips (not in ALLOW_SKIP=${allowRaw}): ${unexpected.join(', ')}`,
      );
      failed = true;
    }
  }

  return failed;
}

if (import.meta.main && await checkApps()) {
  Deno.exit(1);
}
