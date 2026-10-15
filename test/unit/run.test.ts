import { describe, expect, it } from 'vitest';
import { isNotFound, killGroup, run } from '../../scripts/lib/run.ts';

describe('repository subprocess helper', () => {
  it('captures both streams and a nonzero status', async () => {
    expect(
      await run(process.execPath, [
        '-e',
        'process.stdout.write("out"); process.stderr.write("err"); process.exitCode=7',
      ]),
    ).toEqual({ code: 7, stdout: 'out', stderr: 'err' });
  });
  it('inherits streams without returning captured bytes', async () => {
    expect(await run(process.execPath, ['-e', ''], { inherit: true })).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });
  it('replaces the environment, including when it is empty', async () => {
    const child = await run(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: { SETU_RUN_PROOF: 'yes' } },
    );
    expect(JSON.parse(child.stdout)).toEqual({ SETU_RUN_PROOF: 'yes' });
    expect(
      (
        await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
          env: {},
        })
      ).stdout,
    ).toBe('{}');
  });
  it('passes standard input and cwd', async () => {
    const result = await run(
      process.execPath,
      ['-e', 'process.stdin.on("data", b => process.stdout.write(process.cwd()+":"+b))'],
      { cwd: process.cwd(), stdin: 'proof' },
    );
    expect(result.stdout).toBe(process.cwd() + ':proof');
  });
  it('rejects an absent binary with ENOENT', async () => {
    await expect(run('/missing-setu-binary', [])).rejects.toSatisfy(isNotFound);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(new Error('ENOENT'))).toBe(false);
    expect(isNotFound({ code: 'EACCES' })).toBe(false);
  });
  it('keeps an untimed child in the caller process group so Ctrl+C reaches it', async () => {
    const pgid = async (script: string, options = {}) =>
      (await run('sh', ['-c', script], options)).stdout.trim();
    const own = await pgid(`ps -o pgid= -p ${process.pid}`);
    expect(await pgid('ps -o pgid= -p $$')).toBe(own);
    expect(await pgid('ps -o pgid= -p $$', { timeoutMs: 5000 })).not.toBe(own);
  });
  it('kills the child process group on timeout', async () => {
    const result = await run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid)); setInterval(()=>{},1000)'],
      { timeoutMs: 200 },
    );
    expect(result.code).toBe(124);
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('refuses a deadline a Node timer cannot honour, without spawning', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(run('definitely-not-a-binary', [], { timeoutMs })).rejects.toThrow(RangeError);
    }
  });

  it('accepts a fractional deadline, as a budget read from the monotonic clock is', async () => {
    // scripts/audit.ts passes `TOTAL_BUDGET_MS - (now() - started)`, never a whole number.
    const result = await run(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 30_000.75 });
    expect(result.code).toBe(0);
  });

  it('reports signal termination as failure', async () => {
    expect((await run(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'])).code).toBe(
      1,
    );
  });
  it('resolves when a child exits without reading its standard input', async () => {
    const result = await run(process.execPath, ['-e', 'process.exit(3)'], {
      stdin: 'x'.repeat(8 * 1024 * 1024),
    });
    expect(result.code).toBe(3);
  });
});

describe('killGroup', () => {
  const thrower = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  it('kills the negative pid with SIGKILL', () => {
    const calls: unknown[] = [];
    expect(killGroup(42, (...args) => calls.push(args))).toBeUndefined();
    expect(calls).toEqual([[-42, 'SIGKILL']]);
  });
  it('treats a missing pid and an exited group as nothing to raise', () => {
    expect(killGroup(undefined, thrower('EPERM'))).toBeUndefined();
    expect(killGroup(7, thrower('ESRCH'))).toBeUndefined();
  });
  it('returns any other failure', () => {
    expect(killGroup(7, thrower('EPERM'))).toMatchObject({ code: 'EPERM' });
    expect(
      killGroup(7, () => {
        throw 'plain';
      }),
    ).toBe('plain');
  });
});
