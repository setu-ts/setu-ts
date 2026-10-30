import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

import {
  childEnvironment,
  COMMAND_NOT_FOUND,
  createCommandRunner,
} from '../../../src/utils/run-command.ts';

const run = createCommandRunner();
const node = process.execPath;

describe('createCommandRunner (real children)', () => {
  it('cancels a running child through the caller signal', async () => {
    const controller = new AbortController();
    const result = run(node, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();
    expect((await result).code).toBe(1);
  });

  it('captures stdout, stderr and the exit code', async () => {
    const result = await run(
      node,
      ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      { cwd: process.cwd() },
    );
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('writes input to stdin and closes it', async () => {
    const result = await run(
      node,
      [
        '-e',
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))",
      ],
      { cwd: process.cwd(), input: 'kind: Secret\n' },
    );
    expect(result.stdout).toBe('KIND: SECRET\n');
    expect(result.code).toBe(0);
  });

  it('reports the exit code when the child exits without reading its input', async () => {
    // 4 MiB is more than a pipe buffers, so the write is still pending when the child exits.
    const result = await run(node, ['-e', 'process.exit(5)'], {
      cwd: process.cwd(),
      input: 'x'.repeat(4 * 1024 * 1024),
    });
    expect(result.code).toBe(5);
  });

  it('adds env on top of this process environment', async () => {
    const result = await run(
      node,
      ['-e', "process.stdout.write(`${process.env.LC_ALL}:${process.env.PATH ? 'path' : 'none'}`)"],
      { cwd: process.cwd(), env: { LC_ALL: 'C' } },
    );
    expect(result.stdout).toBe('C:path');
  });

  it('removes inherited variables by prefix before adding env', async () => {
    process.env['GIT_DIR_M122_PROBE'] = '/elsewhere';
    try {
      const result = await run(
        node,
        [
          '-e',
          "process.stdout.write(`${process.env.GIT_DIR_M122_PROBE ?? 'gone'}:${process.env.LC_ALL}`)",
        ],
        { cwd: process.cwd(), env: { LC_ALL: 'C' }, unsetPrefixes: ['GIT_'] },
      );
      expect(result.stdout).toBe('gone:C');
    } finally {
      delete process.env['GIT_DIR_M122_PROBE'];
    }
    expect(childEnvironment({ cwd: '/' })).toBeUndefined();
  });

  it('streams to the terminal instead of capturing', async () => {
    const result = await run(node, ['-e', "process.stdout.write('')"], {
      cwd: process.cwd(),
      stream: true,
    });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('passes arguments without a shell', async () => {
    const result = await run(
      node,
      ['-e', 'process.stdout.write(process.argv[1])', '$(echo no) ; |'],
      {
        cwd: process.cwd(),
      },
    );
    expect(result.stdout).toBe('$(echo no) ; |');
  });

  it('reports a missing executable as 127, naming it', async () => {
    const result = await run('setu-m122-no-such-tool', [], { cwd: process.cwd() });
    expect(result.code).toBe(COMMAND_NOT_FOUND);
    expect(result.stderr).toBe('setu-m122-no-such-tool: not found on PATH');
  });
});

describe('createCommandRunner (spawn faults)', () => {
  it('reports another spawn error with its message, and a signal death as 1', async () => {
    const failing = (() => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit(
          'error',
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        ),
      );
      return child;
    }) as unknown as typeof spawn;
    expect(await createCommandRunner(failing)('x', [], { cwd: '/' })).toEqual({
      code: 1,
      stdout: '',
      stderr: 'EACCES: permission denied',
    });

    const killed = (() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', null));
      return child;
    }) as unknown as typeof spawn;
    expect((await createCommandRunner(killed)('x', [], { cwd: '/' })).code).toBe(1);
  });
});
