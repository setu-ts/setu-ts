import { expect, it, vi } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { readRegularFile } from '../../src/utils/node-regular-file.ts';

const boundary = vi.hoisted(() => ({
  process: { exitCode: 0 },
  runMain: vi.fn(() => Promise.resolve(7)),
  nodeProcess: vi.fn(() => ({ host: true })),
  createNodeRuntimeServices: vi.fn(),
}));
vi.mock('node:process', () => ({ default: boundary.process }));
vi.mock('@setu-ts/runtime', () => ({
  createNodeRuntimeServices: boundary.createNodeRuntimeServices,
}));
vi.mock('../../src/main.ts', () => ({
  runMain: boundary.runMain,
  nodeProcess: boundary.nodeProcess,
}));

it('installs the bounded reader at the executable boundary and returns its exit code', async () => {
  const fs = createFakeFs();
  const runtime = { fs, now: () => 5 };
  boundary.createNodeRuntimeServices.mockReturnValue(runtime);
  await import('../../src/bin.ts');
  expect(boundary.runMain).toHaveBeenCalledWith(
    { ...runtime, fs: expect.objectContaining({ readRegularFile }) },
    { host: true },
  );
  expect(boundary.process.exitCode).toBe(7);
});
