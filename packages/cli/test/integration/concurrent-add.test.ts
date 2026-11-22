import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { runCli } from '../../src/cli.ts';

it('V13-148 refuses a concurrent add while its first writer is held inside the project lock', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/concurrent-add-'));
  const fs = { ...createNodeRuntimeServices().fs!, invokingPid: process.pid };
  const errors: string[] = [];
  const deps = {
    fs,
    cwd: root,
    now: () => 0,
    log: () => {},
    error: (line: string) => errors.push(line),
    isProcessAlive: (pid: number) => pid === process.pid,
  };
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first: Promise<number> | undefined;
  try {
    expect(await runCli(['new', 'app'], deps), errors.join('\n')).toBe(0);
    const cwd = `${root}/app`;
    let gated = false;
    first = runCli(['add', 'cache'], {
      ...deps,
      cwd,
      fs: {
        ...fs,
        writeFile: async (path, bytes) => {
          if (!gated && path === `${cwd}/package.json`) {
            gated = true;
            entered();
            await held;
          }
          await fs.writeFile(path, bytes);
        },
      },
    });
    await Promise.race([
      started,
      first.then((code) => {
        throw new Error(`first add returned ${code} before its write gate: ${errors.join('\n')}`);
      }),
    ]);
    const second = await runCli(['add', 'events'], { ...deps, cwd });
    expect(second, errors.join('\n')).toBe(1);
    expect(errors.join('\n')).toContain('Another setu command (add, pid ');
    expect(errors.join('\n')).toContain(`${cwd}/.setu-ts/write.lock`);
    release();
    expect(await first, errors.join('\n')).toBe(0);
    const manifest: { dependencies: Record<string, string> } = JSON.parse(
      await readFile(`${cwd}/package.json`, 'utf8'),
    );
    expect(manifest.dependencies['@setu-ts/cache-plugin']).toBeDefined();
    expect(await readFile(`${cwd}/setu.config.ts`, 'utf8')).toContain('CachePlugin(');
    await expect(fs.stat(`${cwd}/.setu-ts/write.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release();
    await first;
    await rm(root, { recursive: true });
  }
});
