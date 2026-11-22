import { beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  process: {
    exitCode: 0,
    versions: { node: '24.22.1' } as Record<string, string>,
    stderr: { write: vi.fn() },
  },
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
  boundary.process.exitCode = 0;
  boundary.process.versions.node = '24.22.1';
  delete boundary.process.versions.bun;
});

it('runs the shared Node runtime and host at the executable boundary and returns its exit code', async () => {
  await import('../../src/bin.ts');
  expect(boundary.runMain).toHaveBeenCalledExactlyOnceWith({ runtime: true }, { host: true });
  expect(boundary.process.exitCode).toBe(7);
});

it('refuses below the floor without loading the command boundary', async () => {
  boundary.process.versions.node = '18.20.8';
  await import('../../src/bin.ts');
  expect(boundary.runMain).not.toHaveBeenCalled();
  expect(boundary.process.exitCode).toBe(1);
  expect(boundary.process.stderr.write).toHaveBeenCalledExactlyOnceWith(
    'setu needs Node 22.9.0 or newer; this is Node 18.20.8. Supported: ^22.23.4 || ^24.22.1 || >=26.12.1.\n',
  );
});

it.each(['bun', 'deno'])('skips the Node floor on %s', async (runtime) => {
  boundary.process.versions.node = '18.20.8';
  if (runtime === 'bun') boundary.process.versions.bun = '1.4.5';
  else Object.defineProperty(globalThis, 'Deno', { value: {}, configurable: true });
  try {
    await import('../../src/bin.ts');
    expect(boundary.runMain).toHaveBeenCalledOnce();
    expect(boundary.process.exitCode).toBe(7);
    expect(boundary.process.stderr.write).not.toHaveBeenCalled();
  } finally {
    if (runtime === 'deno') Reflect.deleteProperty(globalThis, 'Deno');
  }
});
