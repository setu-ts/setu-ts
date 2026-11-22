/**
 * V13-11 on the real runtimes: the fatal-error observer reports an uncaught
 * exception and an unhandled rejection exactly once, and the process still
 * dies as it would have — exit code 1 and the runtime's own report on stderr.
 * Bun and Deno arms run when their binaries are installed.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const child = fileURLToPath(new URL('../fixtures/fatal-child.ts', import.meta.url));

/** Whether a binary runs here. */
function installed(binary: string): boolean {
  return spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;
}

const runtimes = [
  { name: 'node', command: process.execPath, args: [child], available: true },
  { name: 'bun', command: 'bun', args: [child], available: installed('bun') },
  { name: 'deno', command: 'deno', args: ['run', '-A', child], available: installed('deno') },
];

/** Runs the child and parses its JSON lines. */
function run(
  runtime: (typeof runtimes)[number],
  ...modeArgs: string[]
): { status: number | null; lines: Record<string, unknown>[]; stderr: string } {
  const result = spawnSync(runtime.command, [...runtime.args, ...modeArgs], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  const lines = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, lines, stderr: result.stderr };
}

describe.each(runtimes)('fatal-error observer on $name', (runtime) => {
  it.skipIf(!runtime.available)('reports an uncaught exception once and still exits 1', () => {
    const { status, lines, stderr } = run(runtime, 'throw');
    expect(lines).toEqual([{ origin: 'uncaughtException', message: 'fatal-throw' }]);
    expect(status).toBe(1);
    expect(stderr).toContain('fatal-throw');
  });

  it.skipIf(!runtime.available)('reports an unhandled rejection once and still exits 1', () => {
    const { status, lines, stderr } = run(runtime, 'reject');
    expect(lines).toEqual([{ origin: 'unhandledRejection', message: 'fatal-reject' }]);
    expect(status).toBe(1);
    expect(stderr).toContain('fatal-reject');
  });
});

describe('fatal-error observer on bun with an application listener', () => {
  it.skipIf(!installed('bun'))('keeps a process alive that chose to handle rejections', () => {
    const { status, lines } = run(runtimes[1]!, 'reject', 'own-listener');
    expect(lines).toContainEqual({ own: true });
    expect(lines).toContainEqual({ alive: true });
    expect(status).toBe(0);
  });
});

describe('a rejection when the application has its own uncaughtException listener', () => {
  it.skipIf(!installed('bun'))('still ends Bun, which never routes a rejection to it', () => {
    const { status, lines, stderr } = run(runtimes[1]!, 'reject', 'own-exception-listener');
    expect(lines).toEqual([{ origin: 'unhandledRejection', message: 'fatal-reject' }]);
    expect(status).toBe(1);
    expect(stderr).toContain('fatal-reject');
  });

  it('leaves Node alive with nothing reported, as Node hands the rejection to that listener', () => {
    const { status, lines } = run(runtimes[0]!, 'reject', 'own-exception-listener');
    expect(lines).toEqual([{ caught: true }, { alive: true }]);
    expect(status).toBe(0);
  });
});

describe('a throw the application captures with setUncaughtExceptionCaptureCallback', () => {
  it('is not reported on Node, and the process lives', () => {
    const { status, lines } = run(runtimes[0]!, 'throw', 'capture-callback');
    expect(lines).toEqual([{ captured: true }, { alive: true }]);
    expect(status).toBe(0);
  });
});
