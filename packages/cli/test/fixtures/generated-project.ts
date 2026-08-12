/**
 * Helpers for type-checking a project the CLI just scaffolded.
 *
 * Every e2e in this package does the same two things to a generated project:
 * repoints its `@setu-ts/*` specifiers at THIS workspace, and runs `deno check`
 * over it. They live here so the three gates cannot disagree about what
 * "checked against HEAD" means — a mapping that resolves a starter to the wrong
 * directory, or a compiler option one gate applies and another does not, would
 * make one of them pass vacuously.
 *
 * @module
 */

/** This repository's root, three levels up from `packages/cli/test/`. */
export const REPO_ROOT: string = new URL('../../../../', import.meta.url).pathname.replace(
  /\/$/,
  '',
);

/** Starter packages live one directory deeper than every other package. */
const STARTER_PACKAGES: ReadonlySet<string> = new Set([
  'rest-starter',
  'microservice-starter',
  'full-stack-starter',
]);

/**
 * The workspace's own compiler options, applied to a scaffolded project before
 * it is checked.
 *
 * Repointing at workspace SOURCE means the framework is type-checked too, and
 * it only compiles under the settings it was written against —
 * `exactOptionalPropertyTypes` above all. Without this, checking a project
 * whose import graph reaches far enough into the workspace fails inside
 * framework source rather than in anything the template emitted.
 */
export const WORKSPACE_COMPILER_OPTIONS: Readonly<Record<string, boolean>> = {
  strict: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  exactOptionalPropertyTypes: true,
  useUnknownInCatchVariables: true,
};

/**
 * Maps a bare package name to its entrypoint in this workspace.
 *
 * @param pkg - The package name without the scope
 * @returns The absolute path to its `src/index.ts`
 */
export function workspaceEntrypoint(pkg: string): string {
  const dir = STARTER_PACKAGES.has(pkg) ? `packages/starters/${pkg}` : `packages/${pkg}`;
  return `${REPO_ROOT}/${dir}/src/index.ts`;
}

/**
 * Repoints a scaffolded project's `@setu-ts/*` imports at this workspace, so a
 * check measures drift against HEAD rather than against a published snapshot.
 *
 * That is both more correct and necessary: drift means "the template disagrees
 * with the framework as it is now", and `setu new` pins generated projects to
 * the CLI's OWN version, which during a version bump is not published yet —
 * checking against JSR would deadlock the release workflow against the publish
 * that would fix it.
 *
 * @param root - The project directory holding the `deno.json` to rewrite
 */
export async function useWorkspacePackages(root: string): Promise<void> {
  const manifestPath = `${root}/deno.json`;
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as {
    imports?: Record<string, string>;
    compilerOptions?: Record<string, unknown>;
  };
  const imports: Record<string, string> = {};
  for (const [specifier, target] of Object.entries(manifest.imports ?? {})) {
    // Only framework specifiers are repointed. A template may also declare a
    // project-local alias (`~/` → `./app/`), and rewriting that to a package
    // path would break every module that imports through it.
    if (!specifier.startsWith('@setu-ts/')) {
      imports[specifier] = target;
      continue;
    }
    imports[specifier] = workspaceEntrypoint(specifier.slice('@setu-ts/'.length));
  }
  manifest.imports = imports;
  manifest.compilerOptions = { ...manifest.compilerOptions, ...WORKSPACE_COMPILER_OPTIONS };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/** What a `deno check` subprocess reported. */
export interface CheckResult {
  /** The process exit code. */
  readonly code: number;
  /** Everything it wrote to stderr, decoded. */
  readonly stderr: string;
}

/**
 * Runs `deno check` over a scaffolded project.
 *
 * @param root - The project directory, whose `deno.json` configures the check
 * @param files - Files to check
 * @returns The process result
 */
export async function denoCheck(
  root: string,
  files: readonly string[],
): Promise<CheckResult> {
  const command = new Deno.Command(Deno.execPath(), {
    // `--node-modules-dir=none` because a template that also emits a
    // package.json (a frontend build) would otherwise switch Deno into
    // node_modules resolution, and the gate must not run an npm install to
    // type-check generated TypeScript.
    args: ['check', '--node-modules-dir=none', '--config', `${root}/deno.json`, ...files],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stderr } = await command.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

/**
 * Collects every `.ts` source under a directory, recursively.
 *
 * Recursive because `src/modules/` holds the aggregate barrel BESIDE the module
 * directories, so a fixed two-level walk would try to read a file as a
 * directory.
 *
 * Every `.ts` file is collected, test files included — a generated test whose
 * own imports do not resolve is a defect in what the CLI emitted, so the gate
 * has to see it.
 *
 * @param dir - Directory to walk
 * @returns Absolute paths of the `.ts` files found
 */
export async function collectSources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...(await collectSources(path)));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * A port nothing on this machine is listening on.
 *
 * Never a fixed number: a scaffolded project binds `3000`, and so does anything
 * else a developer happens to be running, so a literal makes the gate report on
 * whichever process won the race. Binding port `0` and closing immediately is the
 * same technique `apps/*` smoke checks use.
 *
 * @returns A free TCP port
 */
export function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

/** How a booted project ended after it was signalled. */
export interface SignalOutcome {
  /** The process exit code. `0` means it shut itself down. */
  readonly code: number;
  /**
   * The signal that killed it, or `null` when it exited under its own control.
   *
   * This is the field that distinguishes a graceful stop from death by signal:
   * a process with no handler for `SIGTERM` is terminated by the kernel and
   * reports `143` here, having run none of its shutdown path.
   */
  readonly killedBySignal: string | null;
  /** Everything it wrote to stdout and stderr, concatenated. */
  readonly output: string;
}

/**
 * Boots a scaffolded project, waits for it to serve, signals it, and reports how
 * it ended.
 *
 * The readiness fetch is not politeness: signalling before the socket is bound
 * measures startup rather than shutdown, and would pass whether or not a handler
 * is installed.
 *
 * @param project - The project directory, already repointed at the workspace
 * @param signal - The signal to send once it is serving
 * @returns How the process ended
 * @throws {Error} If the entry has no literal port to rebind, or never serves
 */
export async function bootAndSignal(
  project: string,
  signal: Deno.Signal,
): Promise<SignalOutcome> {
  const port = unusedPort();
  const entry = `${project}/main.ts`;
  const source = await Deno.readTextFile(entry);
  const patched = source.replace(/port: \d+/, `port: ${port}`);
  if (patched === source) throw new Error(`No literal port to rebind in ${entry}.`);
  await Deno.writeTextFile(entry, patched);

  const child = new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', '--node-modules-dir=none', '--config', `${project}/deno.json`, entry],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  let served = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.body?.cancel();
      served = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const stdout = new Response(child.stdout);
  const stderr = new Response(child.stderr);
  if (!served) {
    child.kill('SIGKILL');
    await child.status;
    throw new Error(`The project never served a request:\n${await stderr.text()}`);
  }

  child.kill(signal);
  const status = await child.status;
  const output = `${await stdout.text()}${await stderr.text()}`;

  return { code: status.code, killedBySignal: status.signal ?? null, output };
}

/** Prefix a probe puts its one-line JSON result behind. */
export const PROBE_MARKER = '__PROBE_RESULT__';

/**
 * Boots a scaffolded project in a subprocess and returns the probe's JSON.
 *
 * A subprocess rather than an in-process import: the project resolves
 * `@setu-ts/*` through its own manifest, and running it here would load a
 * second copy of the framework into this test process.
 *
 * @param project - The project directory, already repointed at the workspace
 * @param probe - The probe module source, written into the project
 * @returns The parsed JSON the probe printed
 * @throws {Error} If the probe exits non-zero or prints no marked line
 */
export async function bootAndProbe(
  project: string,
  probe: string,
): Promise<Record<string, unknown>> {
  await Deno.writeTextFile(`${project}/run-probe.ts`, probe);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '-A',
      '--node-modules-dir=none',
      '--config',
      `${project}/deno.json`,
      `${project}/run-probe.ts`,
    ],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    throw new Error(`probe exited ${code}\n${new TextDecoder().decode(stderr)}`);
  }
  // The booted app logs its own JSON lines to stdout, so the result is carried
  // on ONE line behind a marker rather than located by shape.
  const line = out.split('\n').find((l) => l.startsWith(PROBE_MARKER));
  if (line === undefined) throw new Error(`probe printed no result:\n${out}`);
  return JSON.parse(line.slice(PROBE_MARKER.length)) as Record<string, unknown>;
}

/** What a project booted under its own permissions answered. */
export interface ProbeOutcome {
  /** The status each requested path answered with. */
  readonly statuses: Readonly<Record<string, number>>;
  /** The body of each requested path. */
  readonly bodies: Readonly<Record<string, string>>;
  /** Everything the process wrote, for a failure message. */
  readonly output: string;
}

/**
 * Boots a scaffolded project with the permissions ITS OWN generated `start` task
 * declares, then requests each path.
 *
 * The permission set is the point. Every other fixture here boots with `-A`,
 * which grants what the generated task may have forgotten to ask for and so
 * cannot observe a permission defect at all: a `rest` project shipped for five
 * releases answering 500 on `/health` because its task never requested
 * `--allow-sys`, and an `-A` boot passes that every time.
 *
 * `--config` and `--node-modules-dir` are added on top, since neither grants a
 * permission — the flags under test are exactly the ones the template declared.
 *
 * @param project - The project directory, already repointed at the workspace
 * @param paths - The paths to request once it is serving
 * @returns The status and body of each path
 * @throws {Error} If the entry has no literal port to rebind, or never serves
 */
export async function bootWithGeneratedPermissions(
  project: string,
  paths: readonly string[],
): Promise<ProbeOutcome> {
  const manifest = JSON.parse(await Deno.readTextFile(`${project}/deno.json`)) as {
    tasks?: Record<string, string>;
  };
  const start = manifest.tasks?.['start'];
  if (start === undefined) throw new Error(`No start task in ${project}/deno.json.`);

  // Everything between `deno run` and the entry module is the permission set.
  const flags = start.replace(/^deno run\s+/, '').replace(/\s+\S+\.ts$/, '').split(/\s+/)
    .filter((flag) => flag.startsWith('--'));

  const port = unusedPort();
  const entry = `${project}/main.ts`;
  const source = await Deno.readTextFile(entry);
  const patched = source.replace(/port: \d+/, `port: ${port}`);
  if (patched === source) throw new Error(`No literal port to rebind in ${entry}.`);
  await Deno.writeTextFile(entry, patched);

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      ...flags,
      '--node-modules-dir=none',
      '--config',
      `${project}/deno.json`,
      entry,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const statuses: Record<string, number> = {};
  const bodies: Record<string, string> = {};
  let served = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.body?.cancel();
      served = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (served) {
    for (const path of paths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      statuses[path] = response.status;
      bodies[path] = await response.text();
    }
  }

  child.kill('SIGKILL');
  const status = await child.status;
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr)
    .text()}`;
  if (!served) {
    throw new Error(`The project never served a request (exit ${status.code}):\n${output}`);
  }
  return { statuses, bodies, output };
}
