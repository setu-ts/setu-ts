/** Process ownership probes for launcher e2e tests; all fixture writes stay in OS temp directories. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { expect } from 'vitest';

/** A live Linux process as reported by procfs, excluding zombies. */
export interface LiveProcess {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly command: string;
}

/** Reads the process table without exposing process environments in failure output. */
export async function liveProcesses(): Promise<readonly LiveProcess[]> {
  const entries = await fs.readdir('/proc');
  const rows = await Promise.all(
    entries
      .filter((name) => /^[0-9]+$/.test(name))
      .map(async (name) => {
        try {
          const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (fields[0] === 'Z') return undefined;
          return {
            pid: Number(name),
            parent: Number(fields[1]),
            group: Number(fields[2]),
            command: (await fs.readFile(`/proc/${name}/cmdline`, 'utf8')).replaceAll('\0', ' '),
          };
        } catch {
          // A process may exit between the directory listing and these reads.
          return undefined;
        }
      }),
  );
  return rows.filter((row): row is LiveProcess => row !== undefined);
}

/** Polls a behavioral observation with a fixed upper bound. */
export async function eventually(
  observe: () => boolean | Promise<boolean>,
  message: string,
  milliseconds = 30_000,
): Promise<void> {
  const deadline = performance.now() + milliseconds;
  do {
    if (await observe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  throw new Error(message);
}

/** A launcher-owned process group and captured, in-memory output. */
export interface RunningProcessGroup {
  readonly pid: number;
  readonly status: Promise<number | null>;
  output(): string;
  stop(): Promise<void>;
}

/**
 * Starts tooling in the launcher's own group and verifies SIGTERM leaves no live member.
 * @param executable - The actual executable to start
 * @param args - Its argument vector
 * @param cwd - An OS-temporary generated project
 * @param env - Explicit launcher handoff values
 * @returns The child group, status and bounded teardown
 */
export function launchGroup(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): RunningProcessGroup {
  const child = spawn(executable, [...args], {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let closed = false;
  const status = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    });
  });
  // Report a failed spawn through status even if the caller is polling readiness first.
  void status.catch(() => {});
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('The launcher could not start its child.');
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-pid, name);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
    }
  };
  return {
    pid,
    status,
    output: () => output,
    async stop() {
      const owned = new Set([pid]);
      if (process.platform === 'linux') {
        const before = await liveProcesses();
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of before) {
            if (owned.has(row.parent) && !owned.has(row.pid)) {
              owned.add(row.pid);
              changed = true;
            }
          }
        }
      }
      signal('SIGTERM');
      let failure: unknown;
      try {
        await eventually(
          async () =>
            closed &&
            (process.platform !== 'linux' ||
              !(await liveProcesses()).some((row) => row.group === pid || owned.has(row.pid))),
          'A launcher process survived group SIGTERM',
          10_000,
        );
        if (process.platform === 'linux')
          expect(
            (await liveProcesses()).filter((row) => row.group === pid || owned.has(row.pid)),
          ).toEqual([]);
        await status;
      } catch (cause) {
        failure = cause;
      }
      try {
        // Cleanup preserves any original assertion failure.
        signal('SIGKILL');
        if (process.platform === 'linux') {
          for (const row of await liveProcesses()) {
            if (!owned.has(row.pid)) continue;
            try {
              process.kill(row.pid, 'SIGKILL');
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
            }
          }
        }
      } catch (cause) {
        failure ??= cause;
      }
      if (failure !== undefined) throw failure;
    },
  };
}
