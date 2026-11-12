/**
 * M131c X87-2 and X87-6, end to end: two full-stack members of one npm workspace
 * run side by side in development. The root `dev` script starts both, each binds
 * its own allocated application and Vite ports, and each `start:debug` opens its
 * own inspector — before M131c both bound 3000/5173 and 9229, so the second
 * member never became ready.
 *
 * @module
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { unusedPortRange } from '../fixtures/generated-project.ts';
import { npmInstall, startOverlay } from '../fixtures/node-project.ts';

const runtime = createNodeRuntimeServices();
let root = '';
const children: ChildProcess[] = [];
beforeEach(async () => {
  root = await tempDir({ prefix: 'm131c-dev-ports-' });
});
afterEach(async () => {
  // SIGTERM first: the dev runner starts each member in its own process group and
  // only stops them on a signal it can handle, so a failed run leaks nothing.
  const running = children.splice(0);
  for (const child of running) stop(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  for (const child of running) stop(child);
  await nodeFs.rm(root, { recursive: true, force: true });
});

function cli(args: readonly string[]): Promise<number> {
  return runCli(args, {
    fs: runtime.fs!,
    cwd: root,
    now: () => runtime.now(),
    log: () => {},
    error: () => {},
  });
}

/** Starts a command in its own process group, so stopping it stops its children too. */
function start(
  cwd: string,
  args: readonly string[],
): { child: ChildProcess; output: () => string } {
  const child = spawn('npm', [...args], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean>, what: string, output: () => string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} never happened:\n${output()}`);
}

interface Member {
  readonly name: string;
  readonly port: number;
  readonly inspectPort: number;
  readonly vitePort: number;
}

it(
  'runs two full-stack members side by side in dev, each on its own ports and inspector',
  { timeout: 900_000 },
  async () => {
    const base = await unusedPortRange(2);
    expect(
      await cli(['new', 'ws', '--workspace', '--runtime', 'node', '--port', String(base)]),
    ).toBe(0);
    for (const name of ['web', 'shop'])
      expect(
        await cli(['generate', 'app', name, '--template', 'full-stack', '--dir', `${root}/ws`]),
      ).toBe(0);
    const manifest = JSON.parse(
      await nodeFs.readFile(`${root}/ws/setu.workspace.json`, 'utf8'),
    ) as {
      members: Member[];
    };
    const [web, shop] = manifest.members;
    const ports = [
      web!.port,
      shop!.port,
      web!.vitePort,
      shop!.vitePort,
      web!.inspectPort,
      shop!.inspectPort,
    ];
    expect(new Set(ports).size).toBe(6);

    const overlay = await startOverlay();
    try {
      const installed = await npmInstall(`${root}/ws`, overlay);
      expect(installed.code, installed.output).toBe(0);
    } finally {
      await overlay.close();
    }

    // X87-2: the root dev script starts both members; each answers on its own port
    // and its Vite server listens on its own allocated port.
    const dev = start(`${root}/ws`, ['run', 'dev']);
    for (const member of [web!, shop!]) {
      await until(
        () => healthy(member.port),
        `${member.name} /health on ${member.port}`,
        dev.output,
      );
      expect(await listening(member.vitePort), dev.output()).toBe(true);
    }
    // The runner forwards SIGTERM to each member's process group, so both exit.
    stop(dev.child, 'SIGTERM');
    for (const member of [web!, shop!])
      await until(
        async () => !(await listening(member.vitePort)),
        `${member.name} Vite shutdown`,
        dev.output,
      );
    for (const member of [web!, shop!])
      await until(
        async () => !(await listening(member.port)),
        `${member.name} dev shutdown`,
        dev.output,
      );

    // X87-6: both members debug at once, each inspector on its own loopback port.
    const debug = [web!, shop!].map((member) => ({
      member,
      run: start(`${root}/ws/apps/${member.name}`, ['run', 'start:debug']),
    }));
    for (const { member, run } of debug) {
      await until(() => listening(member.inspectPort), `${member.name} inspector`, run.output);
      await until(() => healthy(member.port), `${member.name} debug /health`, run.output);
    }
  },
);

it(
  'V12-48 refuses an occupied VITE_PORT without dumping a stack',
  { timeout: 900_000 },
  async () => {
    const occupant = createServer();
    await new Promise<void>((resolve, reject) => {
      occupant.once('error', reject);
      occupant.listen(0, '127.0.0.1', resolve);
    });
    const address = occupant.address();
    if (address === null || typeof address === 'string') throw new Error('no occupied port');
    const overlay = await startOverlay();
    try {
      expect(await cli(['new', 'shop', '--template', 'full-stack'])).toBe(0);
      const project = `${root}/shop`;
      const installed = await npmInstall(project, overlay);
      expect(installed.code, installed.output).toBe(0);
      await nodeFs.writeFile(
        `${project}/.env`,
        `SESSION_SECRET=development-only-secret\nVITE_PORT=${address.port}\n`,
      );
      const run = start(project, ['run', 'start:dev']);
      await until(() => Promise.resolve(run.child.exitCode !== null), 'Vite refusal', run.output);
      expect(run.child.exitCode, run.output()).toBe(1);
      expect(run.output()).toContain('Startup failed: Vite could not listen on');
      expect(run.output()).toContain('VITE_PORT');
      expect(run.output()).not.toMatch(/\n\s+at /);
    } finally {
      await overlay.close();
      await new Promise<void>((resolve, reject) =>
        occupant.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
