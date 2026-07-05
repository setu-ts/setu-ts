/**
 * Test fixtures for config-plugin tests.
 *
 * Provides faithful test doubles for IFileSystem and IRuntimeServices.
 */
import type {
  IFileSystem,
  IRuntimeServices,
  RuntimePlatform,
  ServerHandle,
  StatResult,
  TimerHandle,
} from '@hono-enterprise/common';

/** Create a fake IFileSystem backed by an in-memory map. */
export function createFakeFileSystem(files: Record<string, string> = {}): IFileSystem {
  const storage = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    storage.set(path, encoder.encode(content));
  }

  return {
    readFile(path: string): Promise<Uint8Array> {
      const data = storage.get(path);
      if (data === undefined) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve(data);
    },
    writeFile(path: string, data: Uint8Array): Promise<void> {
      storage.set(path, data);
      return Promise.resolve();
    },
    stat(path: string): Promise<StatResult> {
      const data = storage.get(path);
      if (data === undefined) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve({
        isFile: true,
        isDirectory: false,
        size: data.length,
      });
    },
    readdir(): Promise<readonly string[]> {
      return Promise.resolve([...storage.keys()]);
    },
    mkdir(): Promise<void> {
      return Promise.resolve();
    },
    rm(path: string): Promise<void> {
      storage.delete(path);
      return Promise.resolve();
    },
  };
}

/** Create a fake IFileSystem that throws on readFile. */
export function createFailingFileSystem(error: Error): IFileSystem {
  return {
    readFile(): Promise<Uint8Array> {
      return Promise.reject(error);
    },
    writeFile(): Promise<void> {
      return Promise.reject(error);
    },
    stat(): Promise<StatResult> {
      return Promise.reject(error);
    },
    readdir(): Promise<readonly string[]> {
      return Promise.reject(error);
    },
    mkdir(): Promise<void> {
      return Promise.reject(error);
    },
    rm(): Promise<void> {
      return Promise.reject(error);
    },
  };
}

/** Options for creating a fake runtime. */
export interface FakeRuntimeOptions {
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** File system (optional, absent on edge platforms). */
  fs?: IFileSystem;
  /** Platform identifier. */
  platform?: RuntimePlatform;
}

/** Create a minimal but complete IRuntimeServices test double. */
export function createRuntime(opts: FakeRuntimeOptions = {}): IRuntimeServices {
  const clock = 0;
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();

  return {
    platform: () => opts.platform ?? 'deno',
    version: () => '2.0.0-fake',
    hostname: () => 'test-host',
    uuid: () => `test-uuid-${++timerId}`,
    randomBytes: (length: number) => new Uint8Array(length).fill(0),
    get subtle(): SubtleCrypto {
      throw new Error('SubtleCrypto not implemented in fake runtime');
    },
    now: () => clock,
    hrtime: () => clock,
    setTimeout: (fn: () => void, ms: number): TimerHandle => {
      timerId++;
      timers.set(timerId, { fn, delay: ms });
      return timerId;
    },
    clearTimeout: (handle: TimerHandle): void => {
      timers.delete(handle as number);
    },
    setInterval: (fn: () => void, ms: number): TimerHandle => {
      timerId++;
      timers.set(timerId, { fn, delay: ms });
      return timerId;
    },
    clearInterval: (handle: TimerHandle): void => {
      timers.delete(handle as number);
    },
    env: opts.env ?? {},
    fs: opts.fs,
    exit: () => {
      throw new Error('fake runtime exit called');
    },
  } as unknown as IRuntimeServices;
}

/** Opaque type for HTTP adapter stub (not used by config tests). */
export type { ServerHandle };
