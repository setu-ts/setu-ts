/**
 * An in-memory `IFileSystem` plus a recording wrapper, so command tests can
 * exercise every read/write branch without touching disk.
 *
 * @module
 */

import type { IFileSystem, StatResult } from '@setu-ts/common';

/**
 * An in-memory filesystem that also records the mutating calls made against it.
 */
export interface FakeFs extends IFileSystem {
  /** Paths passed to `writeFile`, in call order. */
  readonly writes: readonly string[];
  /** Paths passed to `mkdir`, in call order. */
  readonly mkdirs: readonly string[];
  /**
   * Reads a file back as text.
   *
   * @param path - The path to read
   * @returns The decoded contents
   * @throws {Error} If nothing was written at that path
   */
  read(path: string): string;
  /**
   * Reports whether a path exists in the store.
   *
   * @param path - The path to test
   * @returns True when present
   */
  has(path: string): boolean;
}

/**
 * Creates an error shaped like the one a real runtime throws for a missing
 * path, so callers that branch on `catch` behave as they do in production.
 *
 * @param path - The path that was not found
 * @returns The error to throw
 */
function notFound(path: string): Error {
  const error = new Error(`No such file or directory: ${path}`) as Error & { code?: string };
  error.code = 'ENOENT';
  return error;
}

/**
 * Creates an in-memory filesystem seeded with the given files.
 *
 * @param seed - Path → contents map of files that already exist
 * @returns The fake filesystem
 */
export function createFakeFs(seed: Readonly<Record<string, string>> = {}): FakeFs {
  const store = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const writes: string[] = [];
  const mkdirs: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  for (const [path, contents] of Object.entries(seed)) {
    store.set(path, encoder.encode(contents));
  }

  return {
    writes,
    mkdirs,

    read(path) {
      const bytes = store.get(path);
      if (bytes === undefined) throw new Error(`fake-fs: nothing written at ${path}`);
      return decoder.decode(bytes);
    },

    has(path) {
      return store.has(path);
    },

    readFile(path) {
      const bytes = store.get(path);
      return bytes === undefined ? Promise.reject(notFound(path)) : Promise.resolve(bytes);
    },

    writeFile(path, data) {
      writes.push(path);
      store.set(path, data);
      return Promise.resolve();
    },

    stat(path): Promise<StatResult> {
      const bytes = store.get(path);
      if (bytes !== undefined) {
        return Promise.resolve({ isFile: true, isDirectory: false, size: bytes.length });
      }
      if (dirs.has(path)) {
        return Promise.resolve({ isFile: false, isDirectory: true, size: 0 });
      }
      return Promise.reject(notFound(path));
    },

    readdir(path) {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      return Promise.resolve([...names]);
    },

    mkdir(path) {
      mkdirs.push(path);
      dirs.add(path);
      return Promise.resolve();
    },

    rm(path) {
      store.delete(path);
      dirs.delete(path);
      return Promise.resolve();
    },
  };
}

/**
 * Collects the lines a command writes, for asserting on CLI output.
 */
export interface Recorder {
  /** The recorded lines, in order. */
  readonly lines: readonly string[];
  /** The sink to pass as `log` or `error`. */
  readonly sink: (message: string) => void;
  /** All recorded lines joined by newlines. */
  text(): string;
}

/**
 * Creates an output recorder.
 *
 * @returns The recorder
 */
export function createRecorder(): Recorder {
  const lines: string[] = [];
  return {
    lines,
    sink: (message: string) => {
      lines.push(message);
    },
    text: () => lines.join('\n'),
  };
}
