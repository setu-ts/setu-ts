import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';

const services = vi.hoisted(() => ({ createNodeRuntimeServices: vi.fn() }));
vi.mock('@setu-ts/runtime', () => ({
  createNodeRuntimeServices: services.createNodeRuntimeServices,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it('installs the bounded reader and writer that both executables share', async () => {
  const { readRegularFile, writeRegularFile } =
    await import('../../src/utils/node-regular-file.ts');
  const { nodeRuntime } = await import('../../src/main.ts');
  const runtime = { fs: createFakeFs(), now: () => 5 };
  services.createNodeRuntimeServices.mockReturnValue(runtime);
  expect(nodeRuntime()).toEqual({
    ...runtime,
    fs: expect.objectContaining({ readRegularFile, writeRegularFile }),
  });
});

it('passes a runtime without a filesystem through unchanged', async () => {
  const { nodeRuntime } = await import('../../src/main.ts');
  const runtime = { now: () => 5 };
  services.createNodeRuntimeServices.mockReturnValue(runtime);
  expect(nodeRuntime()).toBe(runtime);
});
