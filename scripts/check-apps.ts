// deno-lint-ignore-file no-console -- this CI script reports progress and skips.
/** Checks every standalone application and runs its mandatory smoke task. */

const SKIP_EXIT_CODE = 77;

interface AppConfig {
  readonly tasks?: Record<string, string>;
}

async function readAppConfig(path: string): Promise<AppConfig> {
  return JSON.parse(await Deno.readTextFile(path)) as AppConfig;
}

async function run(command: readonly string[], cwd: string): Promise<Deno.CommandStatus> {
  return await new Deno.Command(command[0], {
    args: [...command.slice(1)],
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
}

const appDirectories: string[] = [];
for await (const entry of Deno.readDir('apps')) {
  if (entry.isDirectory) {
    appDirectories.push(entry.name);
  }
}
appDirectories.sort();

let failed = false;
for (const directory of appDirectories) {
  const cwd = `apps/${directory}`;
  const config = await readAppConfig(`${cwd}/deno.json`);
  if (!config.tasks?.start || !config.tasks.smoke) {
    console.error(`${directory}: every example must declare start and smoke tasks.`);
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
  if (smoked.code === SKIP_EXIT_CODE) {
    console.warn(`${directory}: smoke skipped (external prerequisite unavailable).`);
  } else if (!smoked.success) {
    failed = true;
  }
}

if (failed) {
  Deno.exit(1);
}
