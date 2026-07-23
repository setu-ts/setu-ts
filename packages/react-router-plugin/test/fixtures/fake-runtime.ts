/**
 * Fake IRuntimeServices with an injectable fs (in-memory readFile map).
 *
 * @module
 * @since 0.1.0
 */

import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';

/**
 * Creates a fake `IFileSystem` backed by an in-memory map.
 *
 * @param fileMap - Map of file paths to Uint8Array contents
 * @returns An `IFileSystem` implementation
 * @since 0.1.0
 */
export function createFakeFileSystem(
  _fileMap: Record<string, Uint8Array> = {},
): IFileSystem {
  void _fileMap;
  return {
    readFile(_path: string): Promise<Uint8Array> {
      throw new Error('not implemented');
    },
    writeFile(_path: string, _data: Uint8Array): Promise<void> {
      void _data;
      return Promise.resolve();
    },
    stat(_path: string): Promise<{ size: number }> {
      void _path;
      return Promise.resolve({ size: 0 });
    },
    readdir(_path: string): Promise<string[]> {
      void _path;
      return Promise.resolve([]);
    },
    mkdir(_path: string): Promise<void> {
      void _path;
      return Promise.resolve();
    },
    rm(_path: string): Promise<void> {
      void _path;
      return Promise.resolve();
    },
  } as unknown as IFileSystem;
}

/**
 * Creates a fake `IRuntimeServices` with an optional `fs`.
 *
 * @param options - Configuration
 * @returns A fake runtime services object
 * @since 0.1.0
 */
export function createFakeRuntime(options?: {
  fs?: IFileSystem | undefined;
}): IRuntimeServices {
  let fs: IFileSystem | undefined;
  if (options?.fs !== undefined) {
    fs = options.fs;
  } else if (options?.fs === null) {
    fs = undefined;
  }

  return {
    platform: () => 'deno',
    version: () => '2.0.0',
    hostname: () => 'localhost',
    uuid: () => 'test-uuid',
    randomBytes: (_length: number) => new Uint8Array(),
    subtle: crypto.subtle,
    now: () => Date.now(),
    hrtime: () => performance.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (handle: ReturnType<typeof setInterval>) => clearInterval(handle),
    env: {},
    exit: () => {
      throw new Error('exit not implemented');
    },
    fs,
  } as unknown as IRuntimeServices;
}
