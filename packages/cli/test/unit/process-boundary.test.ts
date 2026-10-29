import * as nodeFs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { createServer } from 'node:net';
import { tempDir } from '../../../../test/node-helpers.ts';
import { emitInterrupt, type MainProcess, nodeProcess, runMain } from '../../src/main.ts';
import { logicalCwdFor } from '../../src/utils/logical-cwd.ts';

// Host process reads and exits: Deno's (generated Deno source is emitted by the
// allowlisted modules as text) and Node's. Only the boundary may touch them.
const PATTERNS = [
  /prompt\(/,
  /confirm\(/,
  /Deno\.stdin/,
  /Deno\.exit/,
  /process\.exit\(/,
  /process\.stdin/,
  /node:readline/,
] as const;

const ALLOWLIST = [
  'src/bin.ts',
  'src/main.ts',
  'src/terminal-line.ts',
  'src/workspace/dev-runner.ts',
  'src/devtool/dev-entry.ts',
] as const;

const SRC_DIR = new URL('../../src', import.meta.url).pathname.replace(/\/$/, '');

describe('the process boundary of packages/cli/src', () => {
  it('carries no prompt, stdin or exit reference outside the allowlist', async () => {
    const offenders: string[] = [];
    for await (const entry of walk(SRC_DIR)) {
      const relative = `src/${entry.slice(SRC_DIR.length + 1)}`;
      if ((ALLOWLIST as readonly string[]).includes(relative)) continue;
      const source = stripComments(await nodeFs.readFile(entry, 'utf8'));
      for (const pattern of PATTERNS) {
        if (pattern.test(source)) offenders.push(`${relative}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the allowlist to exactly its named entries', () => {
    expect([...ALLOWLIST].sort()).toEqual([
      'src/bin.ts',
      'src/devtool/dev-entry.ts',
      'src/main.ts',
      'src/terminal-line.ts',
      'src/workspace/dev-runner.ts',
    ]);
  });

  it('registers SIGINT through runtime services, not Deno directly', async () => {
    const source = await nodeFs.readFile(new URL('../../src/main.ts', import.meta.url), 'utf8');
    expect(source).toContain("runtime.onSignal?.('SIGINT'");
    expect(source).not.toContain('Deno.addSignalListener');
  });

  it('returns 130 without writes when SIGINT is already delivered at startup', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    let registered: string | undefined;
    const process: MainProcess = {
      args: ['new', 'app'],
      cwd: () => '/work',
      isTerminal: () => true,
      prompt: () => Promise.resolve(''),
      log: () => {},
      error: err.sink,
      portAvailable: () => Promise.resolve(true),
    };
    expect(
      await runMain(
        {
          fs,
          now: () => 0,
          onSignal: (signal, handler) => {
            registered = signal;
            handler();
          },
        },
        process,
      ),
    ).toBe(130);
    expect(registered).toBe('SIGINT');
    expect(fs.writes).toEqual([]);
    expect(err.text()).toContain('Cancelled; nothing was written.');
  });

  it('reports missing filesystem access and runs non-terminal informational commands', async () => {
    const errors = createRecorder();
    const output = createRecorder();
    const process: MainProcess = {
      args: ['--version'],
      cwd: () => '/work',
      isTerminal: () => false,
      prompt: () => Promise.resolve(null),
      log: output.sink,
      error: errors.sink,
      portAvailable: () => Promise.resolve(true),
    };
    expect(await runMain({ now: () => 0 }, process)).toBe(1);
    expect(errors.text()).toContain('requires filesystem access');
    expect(await runMain({ fs: createFakeFs(), now: () => 0 }, process)).toBe(0);
    expect(output.lines).not.toEqual([]);
  });

  it("hands the host's command runner to the workspace commands, and the Node host has one", async () => {
    const hostWith = (
      errors: ReturnType<typeof createRecorder>,
      withRunner: boolean,
    ): MainProcess => ({
      args: ['workspace', 'build', '--dir', '/ws'],
      cwd: () => '/work',
      isTerminal: () => false,
      prompt: () => Promise.resolve(null),
      log: () => {},
      error: errors.sink,
      portAvailable: () => Promise.resolve(true),
      ...(withRunner
        ? { runCommand: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }) }
        : {}),
    });
    // No workspace at /ws, so the command stops before running anything — but it reaches the
    // manifest check only once it has a runner.
    const withRunner = createRecorder();
    expect(await runMain({ fs: createFakeFs(), now: () => 0 }, hostWith(withRunner, true))).toBe(1);
    expect(withRunner.text()).toContain('not a Setu workspace');
    const without = createRecorder();
    expect(await runMain({ fs: createFakeFs(), now: () => 0 }, hostWith(without, false))).toBe(1);
    expect(without.text()).toContain('cannot run docker');
    expect(typeof nodeProcess(() => {}).runCommand).toBe('function');
  });

  it('builds a Node adapter whose port probe reports bind success and refusal', async () => {
    const originalLog = console.log;
    const originalError = console.error;
    const messages: string[] = [];
    console.log = (message) => messages.push(String(message));
    console.error = (message) => messages.push(String(message));
    const held = createServer();
    await new Promise<void>((resolve) => held.listen({ host: '127.0.0.1', port: 0 }, resolve));
    try {
      const host = nodeProcess(() => {});
      expect(host.args).toEqual(process.argv.slice(2));
      expect(host.cwd()).toBe(process.cwd());
      expect(typeof host.isTerminal()).toBe('boolean');
      host.log('out');
      host.error('err');
      expect(messages).toEqual(['out', 'err']);
      const address = held.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      expect(await host.portAvailable(port)).toBe(false);
      expect(await host.portAvailable(0)).toBe(true);
      expect(await host.portAvailable(-1)).toBe(false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  it("routes the Node host's prompt through its reader, and releases it on dispose", async () => {
    const host = nodeProcess(() => {});
    const interrupted = new AbortController();
    interrupted.abort();
    // An already-interrupted run never asks: no reader is opened on stdin.
    expect(await host.prompt('Template? ', interrupted.signal)).toBeNull();
    host.dispose?.();
    // Disposed: every later question answers "no answer" rather than reading.
    expect(await host.prompt('Again? ')).toBeNull();
  });

  it('disposes the host after the run, so an open terminal reader cannot keep it alive', async () => {
    let disposed = 0;
    const host: MainProcess = {
      args: ['--version'],
      cwd: () => '/work',
      isTerminal: () => false,
      prompt: () => Promise.resolve(null),
      log: () => {},
      error: () => {},
      portAvailable: () => Promise.resolve(true),
      dispose: () => {
        disposed++;
      },
    };
    expect(await runMain({ fs: createFakeFs(), now: () => 0 }, host)).toBe(0);
    expect(disposed).toBe(1);
  });

  it('delivers a Ctrl+C at a question as the SIGINT event, never as a real signal', () => {
    // process.kill would terminate the process outright on Windows, and on any
    // platform where no handler is registered; the event only runs handlers.
    const originalKill = process.kill;
    let killed = false;
    process.kill = (() => {
      killed = true;
      return true;
    }) as typeof process.kill;
    let handled = 0;
    const handler = (): void => {
      handled++;
    };
    process.on('SIGINT', handler);
    try {
      emitInterrupt();
    } finally {
      process.off('SIGINT', handler);
      process.kill = originalKill;
    }
    expect(handled).toBe(1);
    expect(killed).toBe(false);
  });

  it('never ends the process itself; the executable sets the exit code', async () => {
    const bin = await nodeFs.readFile(new URL('../../src/bin.ts', import.meta.url), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(stripComments(bin)).toContain('process.exitCode = await runMain(');
    expect(stripComments(bin)).not.toContain('process.exit(');
  });
});

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of await nodeFs.opendir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

function stripComments(source: string): string {
  let out = '';
  let quote: string | undefined;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}

describe('the shell logical working directory', () => {
  it('trusts PWD only when it is absolute and resolves to the physical cwd', async () => {
    const root = await tempDir({ prefix: 'm119h-pwd-' });
    const real = `${root}/real`;
    const link = `${root}/link`;
    const other = `${root}/other`;
    await nodeFs.mkdir(real);
    await nodeFs.mkdir(other);
    await nodeFs.symlink(real, link);
    const previous = process.env['PWD'];
    try {
      process.env['PWD'] = link;
      expect(logicalCwdFor(real)).toBe(link);
      process.env['PWD'] = real;
      expect(logicalCwdFor(real)).toBe(real);
      process.env['PWD'] = other;
      expect(logicalCwdFor(real)).toBeUndefined();
      process.env['PWD'] = `${root}/elsewhere`;
      expect(logicalCwdFor(real)).toBeUndefined();
      process.env['PWD'] = 'relative/path';
      expect(logicalCwdFor(real)).toBeUndefined();
      delete process.env['PWD'];
      expect(logicalCwdFor(real)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['PWD'];
      else process.env['PWD'] = previous;
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it('threads a trusted PWD into the run, so a symlinked member is refused', async () => {
    const root = await nodeFs.realpath(await tempDir({ prefix: 'm119h-pwd-link-' }));
    const real = `${root}/real`;
    const link = `${root}/ws/apps/a`;
    await nodeFs.mkdir(real);
    await nodeFs.mkdir(`${root}/ws/apps`, { recursive: true });
    await nodeFs.symlink(real, link);
    const previous = process.env['PWD'];
    try {
      process.env['PWD'] = link;
      const fs = createFakeFs({
        [`${root}/ws/setu.workspace.json`]: JSON.stringify({
          version: 1,
          basePort: 3000,
          runtime: 'node',
          transport: 'http',
          members: [{ name: 'a', port: 3000 }],
        }),
        [`${real}/package.json`]: '{}',
      });
      const errors: string[] = [];
      const host: MainProcess = {
        args: ['agents'],
        cwd: () => real,
        isTerminal: () => false,
        prompt: () => Promise.resolve(null),
        log: () => {},
        error: (message) => errors.push(message),
        portAvailable: () => Promise.resolve(true),
      };
      expect(await runMain({ fs, now: () => 0 }, host)).toBe(1);
      expect(errors.join('\n')).toContain('is a symlinked member of the workspace at');
      expect(fs.writes).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['PWD'];
      else process.env['PWD'] = previous;
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it('threads a trusted PWD into the run instead of dropping it', async () => {
    const root = await tempDir({ prefix: 'm119h-pwd-thread-' });
    const previous = process.env['PWD'];
    try {
      process.env['PWD'] = root;
      const fs = createFakeFs({ [`${root}/package.json`]: '{}' });
      const host: MainProcess = {
        args: ['agents'],
        cwd: () => root,
        isTerminal: () => false,
        prompt: () => Promise.resolve(null),
        log: () => {},
        error: () => {},
        portAvailable: () => Promise.resolve(true),
      };
      expect(await runMain({ fs, now: () => 0 }, host)).toBe(0);
      expect(fs.writes).toEqual([`${root}/AGENTS.md`]);
    } finally {
      if (previous === undefined) delete process.env['PWD'];
      else process.env['PWD'] = previous;
      await nodeFs.rm(root, { recursive: true, force: true });
    }
  });
});
