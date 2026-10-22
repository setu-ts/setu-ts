import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';

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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('installs the bounded reader and writer at the executable boundary and returns its exit code', async () => {
  const { readRegularFile, writeRegularFile } =
    await import('../../src/utils/node-regular-file.ts');
  const fs = createFakeFs();
  const runtime = { fs, now: () => 5 };
  boundary.createNodeRuntimeServices.mockReturnValue(runtime);
  await import('../../src/bin.ts');
  expect(boundary.runMain).toHaveBeenCalledWith(
    { ...runtime, fs: expect.objectContaining({ readRegularFile, writeRegularFile }) },
    { host: true },
  );
  expect(boundary.process.exitCode).toBe(7);
});

it('passes a runtime without a filesystem through the executable boundary', async () => {
  const runtime = { now: () => 5 };
  boundary.createNodeRuntimeServices.mockReturnValue(runtime);
  await import('../../src/bin.ts');
  expect(boundary.runMain).toHaveBeenCalledExactlyOnceWith(runtime, { host: true });
  expect(boundary.process.exitCode).toBe(7);
});
