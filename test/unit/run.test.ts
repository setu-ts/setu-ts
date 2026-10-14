import { describe, expect, it } from 'vitest';
import { run, isNotFound } from '../../scripts/lib/run.ts';

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
  it('reports signal termination as failure', async () => {
    expect((await run(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'])).code).toBe(
      1,
    );
  });
});
