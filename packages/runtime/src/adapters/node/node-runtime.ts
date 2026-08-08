/**
 * Node.js runtime adapter — provides {@linkcode IRuntimeServices} using
 * Node.js built-in modules.
 *
 * Uses static `node:` imports (supported by Deno, Node, and Bun). The default
 * host is built via {@linkcode buildNodeHost} which routes through an injectable
 * {@linkcode NodeModules} seam so tests can exercise every wrapper without real
 * I/O or permissions — and without `new Function`/`eval`/`require`.
 *
 * @module
 */

import type { IDnsResolver, IFileSystem, IRuntimeServices, IWorkerHost } from '@setu-ts/common';
import { hostname as osHostname } from 'node:os';
import * as nodeFs from 'node:fs/promises';
// `createReadStream` lives in `node:fs`, NOT `node:fs/promises` — the promises
// module exports no such function, so binding the default `fs` module to
// `nodeFs` alone leaves `readStream` permanently unable to open a stream.
import { createReadStream as nodeCreateReadStream } from 'node:fs';
import process from 'node:process';
import { mergeRuntimeServices } from '../../services/cross-runtime.ts';
import { createNodeWorkerHost } from './node-worker-host.ts';
import { createNodeDnsResolver } from '../shared/node-dns-resolver.ts';

// ---------------------------------------------------------------------------
// Injection seam — Node built-ins that the adapter needs
// ---------------------------------------------------------------------------

/**
 * The Node built-ins this adapter needs. Injectable for testing.
 *
 * Tests pass a fake implementation (in-memory fs, mock process, fake hostname)
 * so every wrapper in the adapter executes without real I/O or permissions.
 */
/** File-system operations needed by the Node adapter. */
export interface NodeFsOperations {
  readFile(path: string): Promise<Uint8Array | Buffer>;
  realpath(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | Buffer): Promise<void>;
  stat(path: string): Promise<StatsLike>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  createReadStream?(
    path: string,
    options?: { start?: number; end?: number },
  ): NodeJS.ReadableStream;
}

/** Minimal shape of the Stats object returned by fs.stat(). */
export interface StatsLike {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtime: Date;
}

export interface NodeModules {
  /** File-system operations (compatible with `node:fs/promises`). */
  fs: NodeFsOperations;
  /** Process object (version, env, exit). */
  proc: {
    version: string;
    env: Record<string, string | undefined>;
    exit: (code?: number) => never;
  };
  /** Hostname function (from `node:os`). */
  hostname: () => string;
}

// ---------------------------------------------------------------------------
// Host interface — what the adapter factory consumes
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the Node-specific operations used by this adapter.
 * Inject this interface to test the adapter without real Node.js.
 */
export interface NodeHost {
  /** Node.js version string (e.g. "v18.19.0"). */
  nodeVersion: string;
  /** Host name string. */
  hostname: string;
  /** Environment variable map. */
  env: Record<string, string | undefined>;
  /** Exit the process. */
  exit: (code?: number) => never;
  /** Read file as bytes. */
  readFile: (path: string) => Promise<Uint8Array>;
  /** Resolve a path to its canonical absolute form, following symlinks. */
  realPath: (path: string) => Promise<string>;
  /** Write bytes to a file. */
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** Get file/directory info. */
  stat: (path: string) => Promise<NodeFsInfo>;
  /** List directory entries. */
  readdir: (path: string) => Promise<readonly string[]>;
  /** Create a directory. */
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  /** Remove a file or directory. */
  rm: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  /**
   * Create a read stream for a file.
   * Returns null if the file cannot be opened.
   */
  createReadStream?: (
    path: string,
    options?: { start?: number; end?: number },
  ) => NodeJS.ReadableStream | null;
}

/** File info returned by NodeHost.stat(). */
export interface NodeFsInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date;
}

/**
 * Builds the default {@linkcode NodeHost} from `node:` built-ins, which Deno
 * and Bun also implement.
 *
 * @param mods - Injectable Node modules (defaults to real `node:` built-ins)
 * @returns A fully-wired NodeHost
 */
export function buildNodeHost(
  mods: NodeModules = {
    // `createReadStream` is merged in from `node:fs` because `node:fs/promises`
    // does not export it. Without this the default host resolves it to
    // `undefined` and every `readStream` call throws.
    fs: Object.assign({}, nodeFs, { createReadStream: nodeCreateReadStream }),
    proc: process,
    hostname: osHostname,
  },
): NodeHost {
  return {
    nodeVersion: mods.proc.version,
    hostname: mods.hostname(),
    env: mods.proc.env,
    exit: (code?: number) => mods.proc.exit(code),
    readFile: (path: string) => mods.fs.readFile(path) as Promise<Uint8Array>,
    realPath: (path: string) => mods.fs.realpath(path),
    writeFile: (path: string, data: Uint8Array) => mods.fs.writeFile(path, data) as Promise<void>,
    stat: (path: string): Promise<NodeFsInfo> =>
      mods.fs.stat(path).then((st: StatsLike) => ({
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtime: st.mtime,
      })),
    readdir: (path: string): Promise<readonly string[]> =>
      mods.fs.readdir(path) as Promise<readonly string[]>,
    mkdir: (path: string, options?: { recursive?: boolean }): Promise<void> =>
      mods.fs.mkdir(path, options) as Promise<void>,
    rm: (path: string, options?: { recursive?: boolean }): Promise<void> =>
      mods.fs.rm(path, options) as Promise<void>,
    createReadStream: (
      path: string,
      options?: { start?: number; end?: number },
    ) => mods.fs.createReadStream?.(path, options) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates {@linkcode IRuntimeServices} backed by Node.js APIs.
 *
 * @param host - Injected Node host (defaults to real Node.js via static node: imports)
 * @param workers - Injected worker host (defaults to the `node:worker_threads` host)
 * @param dns - Injected DNS resolver (defaults to the `node:dns/promises` resolver)
 * @returns Complete runtime services for Node.js
 */
export function createNodeRuntimeServices(
  // Built per call rather than once at module load: `buildNodeHost()` calls
  // `os.hostname()` and reads `process.env`, and doing that at import time made
  // merely importing this package require `--allow-sys=hostname` on Deno, on
  // every platform, even when the Node adapter is never constructed.
  host: NodeHost = buildNodeHost(),
  workers: IWorkerHost = createNodeWorkerHost(),
  dns: IDnsResolver = createNodeDnsResolver(),
): IRuntimeServices {
  const fsImpl: IFileSystem = {
    readFile: host.readFile,
    realPath: host.realPath,
    writeFile: host.writeFile,
    stat: host.stat,
    readdir: host.readdir,
    mkdir: host.mkdir,
    rm: host.rm,
    readStream: async (
      path: string,
      _options?: { readonly start?: number; readonly end?: number },
    ): Promise<ReadableStream<Uint8Array>> => {
      if (!host.createReadStream) {
        throw new Error('readStream not supported on this Node.js version');
      }
      const stream = host.createReadStream!(path, _options);
      if (stream === null) {
        throw new Error('Failed to create read stream');
      }
      const { Readable } = await import('node:stream');
      const web = Readable.toWeb(stream as never);
      return web as ReadableStream<Uint8Array>;
    },
  };

  return mergeRuntimeServices({
    platform: () => 'node',
    version: () => host.nodeVersion,
    hostname: () => host.hostname,
    env: host.env as Readonly<Record<string, string | undefined>>,
    exit: (code?: number) => host.exit(code),
    fs: fsImpl,
    workers,
    dns,
  });
}
