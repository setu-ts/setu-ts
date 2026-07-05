/**
 * Node.js runtime adapter — provides {@linkcode IRuntimeServices} using
 * Node.js built-in modules.
 *
 * Uses dependency injection: a {@linkcode NodeHost} interface exposes only the
 * Node-specific operations needed. Unit tests inject a fake host; the default
 * host is only used on actual Node.js after runtime detection.
 *
 * @module
 */

import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';
import { mergeRuntimeServices } from '../../services/cross-runtime.ts';

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

/**
 * Creates {@linkcode IRuntimeServices} backed by Node.js APIs.
 *
 * @param host - Injected Node host (defaults to real Node.js)
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

// ---------------------------------------------------------------------------
// Default Node host — only runs on real Node.js after detection.
// ---------------------------------------------------------------------------

interface NodeStat {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtime: Date;
}

interface NodeFs {
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, d: Uint8Array): Promise<void>;
  stat(p: string): Promise<NodeStat>;
  readdir(p: string): Promise<string[]>;
  mkdir(p: string, o?: { recursive?: boolean }): Promise<void>;
  rm(p: string, o?: { recursive?: boolean }): Promise<void>;
}

interface NodeProcess {
  version: string;
  env: Record<string, string | undefined>;
  exit: (code?: number) => never;
}

interface NodeOs {
  hostname(): string;
}

/**
 * Builds a NodeHost from injected loader functions. The default loaders use
 * Node.js `require`/`import`; tests inject fakes to exercise the host logic
 * without real Node.js.
 */
export function buildNodeHost(loaders: NodeHostLoaders = defaultLoaders): NodeHost {
  let cachedProcess: NodeProcess | undefined;
  let cachedHostname: string | undefined;
  let fsPromise: Promise<NodeFs> | undefined;

  const getProcess = (): NodeProcess => {
    cachedProcess ??= loaders.require<NodeProcess>('node:process');
    return cachedProcess;
  };

  const getHostname = (): string => {
    cachedHostname ??= loaders.require<NodeOs>('node:os').hostname();
    return cachedHostname;
  };

  const getFs = (): Promise<NodeFs> => {
    fsPromise ??= loaders.import<NodeFs>('node:fs/promises');
    return fsPromise;
  };

  return {
    get nodeVersion() {
      return getProcess().version;
    },
    get hostname() {
      return getHostname();
    },
    get env() {
      return getProcess().env;
    },
    exit(code?: number): never {
      getProcess().exit(code);
      throw new Error('unreachable');
    },
    readFile: (path: string): Promise<Uint8Array> => getFs().then((fs) => fs.readFile(path)),
    writeFile: (path: string, data: Uint8Array): Promise<void> =>
      getFs().then((fs) => fs.writeFile(path, data)),
    stat: (path: string): Promise<NodeFsInfo> =>
      getFs().then((fs) => fs.stat(path)).then((st) => ({
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtime: st.mtime,
      })),
    readdir: (path: string): Promise<readonly string[]> =>
      getFs().then((fs) => fs.readdir(path) as unknown as readonly string[]),
    mkdir: (path: string, options?: { recursive?: boolean }): Promise<void> =>
      getFs().then((fs) => fs.mkdir(path, options)),
    rm: (path: string, options?: { recursive?: boolean }): Promise<void> =>
      getFs().then((fs) => fs.rm(path, options)),
  };
}

/** Loader functions for {@linkcode buildNodeHost}. */
export interface NodeHostLoaders {
  /** Synchronous require (Node.js builtins). */
  require: <T>(specifier: string) => T;
  /** Dynamic import (Node.js fs/promises). */
  import: <T>(specifier: string) => Promise<T>;
}

// deno-lint-ignore(no-explicit-any) — Node.js sync require interop
const defaultLoaders: NodeHostLoaders = {
  require: <T>(specifier: string): T => {
    const fn = new Function('s', 'return require(s)') as (s: string) => T;
    return fn(specifier);
  },
  import: <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>,
};

const defaultNodeHost: NodeHost = buildNodeHost();
