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

import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';
import { hostname as osHostname } from 'node:os';
import * as nodeFs from 'node:fs/promises';
import process from 'node:process';
import { mergeRuntimeServices } from '../../services/cross-runtime.ts';

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
  writeFile(path: string, data: Uint8Array | Buffer): Promise<void>;
  stat(path: string): Promise<StatsLike>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
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
}

/** File info returned by NodeHost.stat(). */
export interface NodeFsInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date;
}

// ---------------------------------------------------------------------------
// Factory — builds a NodeHost from injected modules
// ---------------------------------------------------------------------------

/**
 * Builds a {@linkcode NodeHost} from injected modules (defaults to the real
 * `node:` built-ins).
 *
 * @param mods - Injectable Node modules (defaults to real `node:` built-ins)
 * @returns A fully-wired NodeHost
 */
export function buildNodeHost(
  mods: NodeModules = { fs: nodeFs, proc: process, hostname: osHostname },
): NodeHost {
  return {
    nodeVersion: mods.proc.version,
    hostname: mods.hostname(),
    env: mods.proc.env,
    exit: (code?: number) => mods.proc.exit(code),
    readFile: (path: string) => mods.fs.readFile(path) as Promise<Uint8Array>,
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
  };
}

/** Default {@linkcode NodeHost} backed by static `node:` imports. */
const defaultNodeHost: NodeHost = buildNodeHost();

// ---------------------------------------------------------------------------
// Public adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates {@linkcode IRuntimeServices} backed by Node.js APIs.
 *
 * @param host - Injected Node host (defaults to real Node.js via static node: imports)
 * @returns Complete runtime services for Node.js
 */
export function createNodeRuntimeServices(
  host: NodeHost = defaultNodeHost,
): IRuntimeServices {
  const fsImpl: IFileSystem = {
    readFile: host.readFile,
    writeFile: host.writeFile,
    stat: host.stat,
    readdir: host.readdir,
    mkdir: host.mkdir,
    rm: host.rm,
  };

  return mergeRuntimeServices({
    platform: () => 'node',
    version: () => host.nodeVersion,
    hostname: () => host.hostname,
    env: host.env as Readonly<Record<string, string | undefined>>,
    exit: (code?: number) => host.exit(code),
    fs: fsImpl,
  });
}
