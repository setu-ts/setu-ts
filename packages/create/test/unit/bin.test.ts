import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The executable runs on load, so it is imported with both of its effects
// replaced: no real CLI run and no real runtime services.
const runMain = vi.fn((_runtime: unknown, _host: { args: readonly string[] }) => Promise.resolve(3));
vi.mock('@setu-ts/cli/main', () => ({
  runMain,
  nodeProcess: () => ({ args: ['shop', '--template', 'rest'], marker: 'host' }),
}));
vi.mock('@setu-ts/runtime', () => ({ createNodeRuntimeServices: () => ({ marker: 'runtime' }) }));

describe('the npm create executable', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('runs setu new with the caller arguments and sets the exit code it returns', async () => {
    await import('../../src/bin.ts');
    expect(runMain).toHaveBeenCalledTimes(1);
    const [runtime, host] = runMain.mock.calls[0]!;
    expect(runtime).toEqual({ marker: 'runtime' });
    expect(host.args).toEqual(['new', 'shop', '--template', 'rest']);
    expect(process.exitCode).toBe(3);
  });
});
