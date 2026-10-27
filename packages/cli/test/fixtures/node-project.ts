/**
 * Helpers for installing, checking and booting an npm-target project the CLI
 * just scaffolded — the Node half of `generated-project.ts`.
 *
 * Nothing is on npm until the `v0.9.0` cut, and a scaffold pins the CLI's own
 * version, so every install resolves the framework from the local registry
 * overlay (`scripts/registry-overlay.ts`) and everything else from the public
 * registry through it. Unlike the Deno helpers, nothing is repointed: the
 * project installs the tree's own PACKED tarballs, which is what a developer
 * gets from npm after the cut.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { delimiter } from 'node:path';
import {
  type RegistryOverlay,
  startRegistryOverlay,
} from '../../../../scripts/registry-overlay.ts';
import { REPO_ROOT, unusedPort } from './generated-project.ts';

export type { RegistryOverlay };

/**
 * Starts the overlay over this tree's packs, building them the first time.
 *
 * @param publishedAt - `'now'` stamps packuments with the current time
 * @returns The running overlay; close it after the suite
 */
export function startOverlay(publishedAt: 'default' | 'now' = 'default'): Promise<RegistryOverlay> {
  return startRegistryOverlay({ root: REPO_ROOT, publishedAt });
}

/** What a command run inside a project reported. */
export interface CommandResult {
  readonly code: number;
  /** stdout and stderr, concatenated. */
  readonly output: string;
}

/**
 * The environment every command in a scaffolded npm project runs under: the
 * overlay as the registry, and the project's own `node_modules/.bin` first on
 * `PATH`, exactly as `npm run` arranges it.
 */
function projectEnv(project: string, overlay?: RegistryOverlay): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${project}/node_modules/.bin${delimiter}${process.env['PATH'] ?? ''}`,
    ...(overlay === undefined ? {} : { NPM_CONFIG_REGISTRY: overlay.url }),
    // Quiet npm without changing what it does.
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

/**
 * Runs a command in a project and collects its output.
 *
 * @param project - The project directory
 * @param command - The executable
 * @param args - Its arguments
 * @param overlay - The registry to install from, when the command installs
 * @returns The exit code and output
 */
export function runIn(
  project: string,
  command: string,
  args: readonly string[],
  overlay?: RegistryOverlay,
  env: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: project,
      env: { ...projectEnv(project, overlay), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Installs a scaffolded project from the overlay with plain `npm install`.
 *
 * @param project - The project directory
 * @param overlay - The running overlay
 * @returns The exit code and output
 */
export function npmInstall(project: string, overlay: RegistryOverlay): Promise<CommandResult> {
  return runIn(project, 'npm', ['install', '--no-audit', '--no-fund'], overlay);
}

/**
 * Runs one of the project's own `package.json` scripts.
 *
 * @param project - The project directory
 * @param script - The script name
 * @returns The exit code and output
 */
export function npmRun(project: string, script: string): Promise<CommandResult> {
  return runIn(project, 'npm', ['run', '--silent', script]);
}

/**
 * Signals a child spawned with `detached: true` together with everything it
 * started: `npm` and `tsx` each run the entry in a child of their own, so
 * signalling the direct child alone would leave the application holding the
 * pipes this fixture waits on.
 *
 * A negative PID addresses the process group on POSIX. Windows has no process
 * groups, so there the direct child is signalled and the tree kill falls back to
 * `taskkill /T`; these e2e suites run on Linux in CI.
 */
function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The group is already gone; its status and output remain.
  }
}

/** A running `npm start`, killed as a whole process group. */
interface StartedServer {
  readonly status: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly output: () => string;
  signal(signal: NodeJS.Signals): void;
}

/**
 * Starts the project's own `start` script — so a template with a frontend build
 * builds first — in a process group of its own, since `npm` and `tsx` each run
 * the entry in a child.
 */
function startServer(project: string, port: number): StartedServer {
  const child = spawn('npm', ['start', '--silent'], {
    cwd: project,
    env: { ...projectEnv(project), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const status = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  return {
    status,
    output: () => output,
    signal(signal) {
      signalTree(child.pid, signal);
    },
  };
}

/** Polls `origin` until it answers, or gives up. */
async function waitForServer(origin: string, attempts = 600): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${origin}/`);
      await response.body?.cancel();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/**
 * Boots an installed project through its own `start` script and hands its
 * origin to a caller that drives it, then kills the process group.
 *
 * @param project - The installed project directory
 * @param drive - Called once the project is serving, with a reader for what the
 *   process has written so far (to wait for output before the kill)
 * @returns What `drive` returned, and everything the process wrote
 * @throws {Error} If the project never serves, or `drive` rejects
 */
export async function withNodeServer<T>(
  project: string,
  drive: (origin: string, output: () => string) => Promise<T>,
): Promise<{ readonly result: T; readonly output: string }> {
  const port = await unusedPort();
  const server = startServer(project, port);
  const origin = `http://127.0.0.1:${port}`;
  const served = await Promise.race([waitForServer(origin), server.status.then(() => false)]);
  let result: T | undefined;
  let failure: unknown;
  try {
    if (served) result = await drive(origin, () => server.output());
  } catch (error) {
    failure = error;
  } finally {
    server.signal('SIGKILL');
  }
  await server.status;
  if (!served) throw new Error(`The project never served a request:\n${server.output()}`);
  if (failure !== undefined) {
    throw new Error(`Driving the project failed:\n${server.output()}`, { cause: failure });
  }
  return { result: result as T, output: server.output() };
}

/**
 * Boots an installed project's entry the way a container's PID 1 runs it —
 * `tsx main.ts`, the generated `start` command — signals that process once it
 * serves, and reports how it ended.
 *
 * Not through `npm start`: npm handles a signal itself, so its exit status
 * would describe npm rather than the application's shutdown path.
 *
 * @param project - The installed project directory
 * @param signal - The signal to deliver once it is serving
 * @returns The exit code, the signal that ended it (if any), and its output
 */
export async function nodeBootAndSignal(
  project: string,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  const port = await unusedPort();
  // Its own process group, so the CLEANUP below reaches the application `tsx`
  // runs as a child; the signal under test still goes to `tsx` alone, which
  // relays it — exactly what a container's PID 1 receives.
  const child = spawn(`${project}/node_modules/.bin/tsx`, ['main.ts'], {
    cwd: project,
    env: { ...projectEnv(project), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const status = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, ended) => resolve({ code, signal: ended })),
  );
  const served = await Promise.race([
    waitForServer(`http://127.0.0.1:${port}`),
    status.then(() => false),
  ]);
  if (!served) {
    signalTree(child.pid, 'SIGKILL');
    await status;
    throw new Error(`The project never served a request:\n${output}`);
  }
  child.kill(signal);
  const watchdog = setTimeout(() => signalTree(child.pid, 'SIGKILL'), 15_000);
  const ended = await status;
  clearTimeout(watchdog);
  // A clean exit of `tsx` can still leave a straggler in the group; reap it.
  signalTree(child.pid, 'SIGKILL');
  return { ...ended, output };
}

/**
 * Whether a project's `node_modules` holds a package.
 *
 * @param project - The installed project directory
 * @param name - The package name
 * @returns Whether its `package.json` is present
 */
export async function installed(project: string, name: string): Promise<boolean> {
  try {
    await nodeFs.stat(`${project}/node_modules/${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}
