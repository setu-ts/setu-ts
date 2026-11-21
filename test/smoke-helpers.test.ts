import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freePort, startHost, stopHost } from '../apps/smoke-helpers.ts';
import { unusedPort } from './node-helpers.ts';

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

describe('freePort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /** The `Math.random()` value that makes `freePort` draw exactly `port`. */
  const drawing = (port: number): number => (port - 20_000 + 0.5) / 12_768;

  it('draws a bindable port below the range the operating system assigns from', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(port).toBeLessThanOrEqual(32_767);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('draws again when the port is already bound, and gives up after twenty draws', async () => {
    const taken = await unusedPort();
    const free = await unusedPort();
    const occupant = createServer();
    await new Promise<void>((resolve) => occupant.listen(taken, '127.0.0.1', resolve));
    try {
      const random = vi
        .spyOn(Math, 'random')
        .mockReturnValueOnce(drawing(taken))
        .mockReturnValueOnce(drawing(free));
      expect(await freePort()).toBe(free);
      expect(random).toHaveBeenCalledTimes(2);

      random.mockReset().mockReturnValue(drawing(taken));
      await expect(freePort()).rejects.toMatchObject({
        message: 'No free loopback port between 20000 and 32767.',
        cause: { code: 'EADDRINUSE' },
      });
      expect(random).toHaveBeenCalledTimes(20);
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    }
  });
});
