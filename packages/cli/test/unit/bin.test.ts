import { beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  process: { exitCode: 0 },
  runMain: vi.fn(() => Promise.resolve(7)),
  nodeProcess: vi.fn(() => ({ host: true })),
  nodeRuntime: vi.fn(() => ({ runtime: true })),
}));
vi.mock('node:process', () => ({ default: boundary.process }));
vi.mock('../../src/main.ts', () => ({
  runMain: boundary.runMain,
  nodeProcess: boundary.nodeProcess,
  nodeRuntime: boundary.nodeRuntime,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('runs the shared Node runtime and host at the executable boundary and returns its exit code', async () => {
  await import('../../src/bin.ts');
  expect(boundary.runMain).toHaveBeenCalledExactlyOnceWith({ runtime: true }, { host: true });
  expect(boundary.process.exitCode).toBe(7);
});
