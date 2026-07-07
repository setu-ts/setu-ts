/**
 * Test fixtures for decorator-plugin tests — deterministic runtime services
 * and an in-memory file system that supports directory walking (for discovery
 * tests). No runtime-specific APIs; only web-standard (`TextEncoder`, `Map`).
 *
 * @module
 */
import type {
  IFileSystem,
  IRuntimeServices,
  RuntimePlatform,
  StatResult,
  TimerHandle,
} from '@hono-enterprise/common';

/** Normalizes a path to a leading-slash, no-trailing-slash form. */
function normalizePath(path: string): string {
  let n = path.trim();
  if (!n.startsWith('/')) {
    n = '/' + n;
  }
  if (n.length > 1 && n.endsWith('/')) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * Creates an in-memory `IFileSystem` backed by a path→content map. Directory
 * structure is derived from file paths, so `readdir` and `stat` support
 * recursive walking. File contents are irrelevant to discovery (which only
 * lists and imports) but kept for `readFile`.
 *
 * @param files - Path → file content
 */
export function createFakeFileSystem(files: Record<string, string> = {}): IFileSystem {
  const storage = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    storage.set(normalizePath(path), encoder.encode(content));
  }
  const dirs = new Set<string>(['/']);
  for (const path of storage.keys()) {
    const parts = path.split('/').filter((s) => s !== '');
    for (let i = 1; i < parts.length; i++) {
      dirs.add('/' + parts.slice(0, i).join('/'));
    }
  }

  return {
    readFile(path: string): Promise<Uint8Array> {
      const data = storage.get(normalizePath(path));
      if (data === undefined) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve(data);
    },
    writeFile(path: string, data: Uint8Array): Promise<void> {
      storage.set(normalizePath(path), data);
      return Promise.resolve();
    },
    stat(path: string): Promise<StatResult> {
      const n = normalizePath(path);
      const data = storage.get(n);
      if (data !== undefined) {
        return Promise.resolve({ isFile: true, isDirectory: false, size: data.length });
      }
      if (dirs.has(n)) {
        return Promise.resolve({ isFile: false, isDirectory: true, size: 0 });
      }
      return Promise.reject(new Error(`Not found: ${path}`));
    },
    readdir(path: string): Promise<readonly string[]> {
      const n = normalizePath(path);
      const prefix = n === '/' ? '/' : n + '/';
      const entries = new Set<string>();
      for (const p of storage.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first !== '') {
            entries.add(first);
          }
        }
      }
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first !== '') {
            entries.add(first);
          }
        }
      }
      return Promise.resolve([...entries]);
    },
    mkdir(): Promise<void> {
      return Promise.resolve();
    },
    rm(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Options for creating a fake runtime. */
export interface FakeRuntimeOptions {
  /** Environment variables. */
  readonly env?: Record<string, string | undefined>;
  /** File system (absent by default, as on edge platforms). */
  readonly fs?: IFileSystem;
  /** Platform identifier. */
  readonly platform?: RuntimePlatform;
}

/** Counter backing deterministic UUIDs and timer handles. */
let fakeCounter = 0;

/** Resets the shared fake counter (call in `beforeEach` for isolation). */
export function resetFakeCounter(): void {
  fakeCounter = 0;
}

/**
 * Creates a minimal, deterministic `IRuntimeServices`. The clock is fixed at
 * `0` (monotonic `hrtime`/`now`); UUIDs are sequential.
 *
 * @param opts - Environment, file system, platform
 */
export function createFakeRuntime(opts: FakeRuntimeOptions = {}): IRuntimeServices {
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  return {
    platform: () => opts.platform ?? 'deno',
    version: () => '2.0.0-fake',
    hostname: () => 'test-host',
    uuid: () => `test-uuid-${++fakeCounter}`,
    randomBytes: (length: number) => new Uint8Array(length).fill(0),
    get subtle(): SubtleCrypto {
      throw new Error('SubtleCrypto not available in fake runtime');
    },
    now: () => 0,
    hrtime: () => 0,
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
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
    exit: () => {
      throw new Error('fake runtime exit called');
    },
  } as unknown as IRuntimeServices;
}
