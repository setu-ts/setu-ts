/**
 * Node.js runtime adapter — provides {@linkcode IRuntimeServices} using
 * Node.js built-in modules.
 *
 * Uses static `node:` imports (supported by Deno, Node, and Bun). The default
 * host is built directly from those imports. A {@linkcode NodeHost} interface
 * remains as an injection seam for unit tests.
 *
 * @module
 */

import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';
import { hostname as osHostname } from 'node:os';
import type { Stats as NodeStats } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import process from 'node:process';
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

// ---------------------------------------------------------------------------
// Default Node host — built from static node: imports (Deno/Node/Bun compatible).
// ---------------------------------------------------------------------------

/** Default {@linkcode NodeHost} backed by static `node:` imports. */
const defaultNodeHost: NodeHost = {
  get nodeVersion() {
    return process.version;
  },
  get hostname() {
    return osHostname();
  },
  get env() {
    return process.env;
  },
  exit(code?: number): never {
    process.exit(code);
    throw new Error('unreachable');
  },
  readFile: (path: string) => nodeFs.readFile(path) as Promise<Uint8Array>,
  writeFile: (path: string, data: Uint8Array) => nodeFs.writeFile(path, data) as Promise<void>,
  stat: (path: string): Promise<NodeFsInfo> =>
    nodeFs.stat(path).then((st: NodeStats) => ({
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mtime: st.mtime,
    })),
  readdir: (path: string): Promise<readonly string[]> =>
    nodeFs.readdir(path) as Promise<readonly string[]>,
  mkdir: (path: string, options?: { recursive?: boolean }): Promise<void> =>
    nodeFs.mkdir(path, options) as Promise<void>,
  rm: (path: string, options?: { recursive?: boolean }): Promise<void> =>
    nodeFs.rm(path, options) as Promise<void>,
};
