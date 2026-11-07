import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startHost, stopHost } from '../apps/smoke-helpers.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const appsDir = join(root, 'apps');

/** A `-e` script that exits 0 only when the child's cwd is `expected`. */
const cwdProbe = (expected: string): string =>
  `process.exit(process.cwd() === ${JSON.stringify(expected)} ? 0 : 1)`;

describe('startHost cwd option', () => {
  it('runs the child in the cwd it is given', async () => {
    const host = startHost(process.execPath, ['-e', cwdProbe(appsDir)], undefined, {
      cwd: appsDir,
    });
    // Let the short child exit on its own: stopHost's immediate SIGTERM would otherwise race
    // the child's startup and report the signal's exit code, not the probe's.
    await host.status;
    expect(await stopHost(host)).toBe(0);
  });

  it('still runs the child in the caller cwd when the option is omitted', async () => {
    // The 3-arg form the existing callers use: no options argument at all.
    const host = startHost(process.execPath, ['-e', cwdProbe(process.cwd())]);
    await host.status;
    expect(await stopHost(host)).toBe(0);
  });

  it('exits non-zero when the child is not in the cwd it was given', async () => {
    const host = startHost(process.execPath, ['-e', cwdProbe(appsDir)], undefined, { cwd: root });
    await host.status;
    expect(await stopHost(host)).toBe(1);
  });
});
