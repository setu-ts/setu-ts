import { beforeEach, describe, expect, it, vi } from 'vitest';

// The executable runs on load, so it is imported with its effects replaced: no
// real CLI run, no real runtime services and a controllable process.
const boundary = vi.hoisted(() => ({
  process: {
    exitCode: undefined as number | undefined,
    versions: { node: '24.22.1' } as Record<string, string>,
    stderr: { write: vi.fn() },
  },
  runMain: vi.fn((_runtime: unknown, _host: { args: readonly string[] }) => Promise.resolve(3)),
}));
vi.mock('node:process', () => ({ default: boundary.process }));
// The CLI's own Node runtime, so the writer that creates secret files owner-only is the one
// `setu` uses (M140c audit F2).
vi.mock('@setu-ts/cli/main', () => ({
  runMain: boundary.runMain,
  nodeRuntime: () => ({ marker: 'runtime' }),
  nodeProcess: () => ({ args: ['shop', '--template', 'rest'], marker: 'host' }),
}));

describe('the npm create executable', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    boundary.process.exitCode = undefined;
    boundary.process.versions.node = '24.22.1';
  });

  it('runs setu new with the caller arguments and sets the exit code it returns', async () => {
    await import('../../src/bin.ts');
    expect(boundary.runMain).toHaveBeenCalledTimes(1);
    const [runtime, host] = boundary.runMain.mock.calls[0]!;
    expect(runtime).toEqual({ marker: 'runtime' });
    expect(host.args).toEqual(['new', 'shop', '--template', 'rest']);
    expect(boundary.process.exitCode).toBe(3);
  });

  it('refuses below the Node floor without loading setu new', async () => {
    boundary.process.versions.node = '20.20.2';
    await import('../../src/bin.ts');
    expect(boundary.runMain).not.toHaveBeenCalled();
    expect(boundary.process.exitCode).toBe(1);
    expect(boundary.process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      'setu needs Node 22.9.0 or newer; this is Node 20.20.2. Supported: ^22.23.4 || ^24.22.1 || >=26.12.1.\n',
    );
  });
});
