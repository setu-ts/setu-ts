import { afterEach, describe, expect, it, vi } from 'vitest';
import process from 'node:process';
import { createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import { createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';
import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';
import type { DenoHost } from '../../src/adapters/deno/deno-runtime.ts';
import { createCloudflareRuntimeServices } from '../../src/adapters/workers/cf-runtime.ts';

afterEach(() => vi.restoreAllMocks());

describe('runtime reportError', () => {
  for (const [name, create] of [
    ['node', createNodeRuntimeServices],
    ['bun', createBunRuntimeServices],
  ] as const) {
    it(`${name} writes exactly one JSON line and contains serialization and write failures`, () => {
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const runtime = create();
      runtime.reportError?.({ level: 'error', message: 'fault' });
      expect(write).toHaveBeenCalledExactlyOnceWith('{"level":"error","message":"fault"}\n');
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => runtime.reportError?.(cyclic)).not.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
      write.mockImplementation(() => {
        throw new Error('closed stderr');
      });
      expect(() => runtime.reportError?.({ message: 'fault' })).not.toThrow();
    });
  }

  it('Deno writes encoded JSON to stderr and contains failures', () => {
    const writeSync = vi.fn((data: Uint8Array) => data.length);
    const host = {
      build: { os: 'windows' },
      env: { toObject: () => ({}) },
      stderr: { writeSync },
    } as unknown as DenoHost;
    const runtime = createDenoRuntimeServices(host);
    runtime.reportError?.({ message: 'fault' });
    expect(writeSync).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(writeSync.mock.calls[0]?.[0])).toBe('{"message":"fault"}\n');
    expect(() => runtime.reportError?.({ value: 1n })).not.toThrow();
    writeSync.mockImplementation(() => {
      throw new Error('closed stderr');
    });
    expect(() => runtime.reportError?.({ message: 'fault' })).not.toThrow();
    delete host.stderr;
    expect(() => runtime.reportError?.({ message: 'legacy host' })).not.toThrow();
  });

  it('Workers uses the platform log channel and contains failures', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = createCloudflareRuntimeServices();
    runtime.reportError?.({ message: 'fault' });
    expect(sink).toHaveBeenCalledExactlyOnceWith('{"message":"fault"}');
    expect(() => runtime.reportError?.({ value: 1n })).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    sink.mockImplementation(() => {
      throw new Error('sink failed');
    });
    expect(() => runtime.reportError?.({ message: 'fault' })).not.toThrow();
  });
});
