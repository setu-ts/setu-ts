import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The executable runs on load, so it is imported with both of its effects
// replaced: no real CLI run and no real runtime services.
const runMain = vi.fn(() => Promise.resolve(7));
vi.mock('../../src/main.ts', () => ({ runMain, nodeProcess: () => ({ marker: 'host' }) }));
vi.mock('@setu-ts/runtime', () => ({ createNodeRuntimeServices: () => ({ marker: 'runtime' }) }));

describe('the setu executable', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('runs the CLI over the Node host and runtime and sets the exit code it returns', async () => {
    await import('../../src/bin.ts');
    expect(runMain).toHaveBeenCalledWith({ marker: 'runtime' }, { marker: 'host' });
    expect(process.exitCode).toBe(7);
  });
});
