/**
 * Deno runtime adapter — provides {@linkcode IRuntimeServices} using Deno APIs.
 *
 * Uses dependency injection: a {@linkcode DenoHost} interface exposes only the
 * Deno-specific operations needed, defaulting to the real `Deno` global via a
 * single boundary cast. This allows unit testing on any runtime by passing a
 * fake host.
 *
 * @module
 */

import type {
  IDnsResolver,
  IFileSystem,
  IRuntimeServices,
  IWorkerHost,
} from '@hono-enterprise/common';
import { mergeRuntimeServices } from '../../services/cross-runtime.ts';
import { createWebWorkerHost } from '../shared/web-worker-host.ts';
import { createDenoDnsResolver } from './deno-dns-resolver.ts';
import type { DenoSrvRecord } from './deno-dns-resolver.ts';

/**
 * Minimal interface covering the Deno-specific operations used by this adapter.
 * Inject this interface to test the adapter without real Deno.
 */
export interface DenoHost {
  /** Current runtime version string. */
  version: { deno: string };
  /** Returns the host name. */
  hostname(): string;
  /** Environment variable map. */
  env: { toObject(): Record<string, string> };
  /** Exit the process. */
  exit(code?: number): never;
  /** Read file as bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /** Resolve a path to its canonical absolute form, following symlinks. */
  realPath(path: string): Promise<string>;
  /** Write bytes to a file. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Get file/directory info. */
  stat(path: string): Promise<DenoFileInfo>;
  /**
   * Lists directory entries. Named and shaped after the real API this host
   * defaults to: `Deno.readDir` (capital `D`) returns an **async** iterable,
   * so it must be consumed with `for await`.
   */
  readDir(path: string): AsyncIterable<DenoDirEntry>;
  /** Create a directory. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Remove a file or directory. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Resolves SRV records. */
  resolveDns(query: string, recordType: 'SRV'): Promise<DenoSrvRecord[]>;
  /** Resolves address records. */
  resolveDns(query: string, recordType: 'A' | 'AAAA'): Promise<string[]>;
}

/** File info returned by DenoHost.stat(). */
export interface DenoFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date | null;
}

/** Directory entry returned by DenoHost.readdir(). */
export interface DenoDirEntry {
  name: string;
}

/**
 * Creates {@linkcode IRuntimeServices} backed by Deno APIs.
 *
 * @param host - Injected Deno host (defaults to real Deno global)
 * @param workers - Injected worker host (defaults to the web `Worker` host)
 * @param dns - Injected DNS resolver (defaults to one over the host's `resolveDns`)
 * @returns Complete runtime services for Deno
 */
export function createDenoRuntimeServices(
  host: DenoHost = Deno as unknown as DenoHost,
  workers: IWorkerHost = createWebWorkerHost(),
  dns: IDnsResolver = createDenoDnsResolver(host),
): IRuntimeServices {
  const fs: IFileSystem = {
    readFile: (path: string) => host.readFile(path),
    realPath: (path: string) => host.realPath(path),
    writeFile: (path: string, data: Uint8Array) => host.writeFile(path, data),
    stat: (path: string) =>
      host.stat(path).then((info) => ({
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        size: info.size,
        ...(info.mtime !== null ? { mtime: info.mtime } : {}),
      })),
    readdir: async (path: string) => {
      const entries: string[] = [];
      for await (const entry of host.readDir(path)) {
        entries.push(entry.name);
      }
      return entries as readonly string[];
    },
    mkdir: (path: string, options?: { readonly recursive?: boolean }) => host.mkdir(path, options),
    rm: (path: string, options?: { readonly recursive?: boolean }) => host.remove(path, options),
  };

  return mergeRuntimeServices({
    platform: () => 'deno',
    version: () => host.version.deno,
    hostname: () => host.hostname(),
    env: host.env.toObject() as Readonly<Record<string, string | undefined>>,
    exit: (code?: number) => host.exit(code),
    fs,
    workers,
    dns,
  });
}
