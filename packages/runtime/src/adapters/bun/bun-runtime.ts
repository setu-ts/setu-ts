/**
 * Bun runtime adapter — provides {@linkcode IRuntimeServices} using Bun APIs.
 *
 * Uses dependency injection: a {@linkcode BunHost} interface exposes only the
 * Bun-specific operations needed, defaulting to the real `Bun` global via a
 * single boundary cast. This allows unit testing on any runtime by passing a
 * fake host.
 *
 * @module
 */

import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';
import { mergeRuntimeServices } from '../../services/cross-runtime.ts';

/**
 * Minimal interface covering the Bun-specific operations used by this adapter.
 * Inject this interface to test the adapter without real Bun.
 */
export interface BunHost {
  /** Bun version string. */
  version: string;
  /** Returns the host name. */
  hostname: string;
  /** Environment variable map. */
  env: { [key: string]: string | undefined };
  /** Exit the process. */
  exit: (code?: number) => never;
  /** Read file as bytes. */
  readFile: (path: string) => Uint8Array | null;
  /** Write bytes to a file. */
  writeFile: (path: string, data: Uint8Array) => void;
  /** Get file/directory info. */
  stat: (path: string) => BunFileInfo | null;
  /** List directory entries. */
  readdir: (path: string) => readonly string[] | null;
  /** Create a directory. */
  mkdir: (path: string, options?: { recursive?: boolean }) => boolean;
  /** Remove a file or directory. */
  rm: (path: string, options?: { recursive?: boolean }) => boolean;
}

/** File info returned by BunHost.stat(). */
export interface BunFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date;
}

/**
 * Creates {@linkcode IRuntimeServices} backed by Bun APIs.
 *
 * @param host - Injected Bun host (defaults to real Bun global)
 * @returns Complete runtime services for Bun
 */
export function createBunRuntimeServices(
  host: BunHost = defaultBunHost,
): IRuntimeServices {
  const fs: IFileSystem = {
    readFile: (path: string) => {
      const data = host.readFile(path);
      if (data === null) {
        return Promise.reject(new Error(`ENOENT: no such file or directory, read '${path}'`));
      }
      return Promise.resolve(data);
    },
    writeFile: (path: string, data: Uint8Array) => {
      host.writeFile(path, data);
      return Promise.resolve();
    },
    stat: (path: string) => {
      const info = host.stat(path);
      if (info === null) {
        return Promise.reject(new Error(`ENOENT: no such file or directory, stat '${path}'`));
      }
      return Promise.resolve({
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        size: info.size,
        mtime: info.mtime,
      });
    },
    readdir: (path: string) => {
      const entries = host.readdir(path);
      if (entries === null) {
        return Promise.reject(
          new Error(`ENOENT: no such file or directory, readdir '${path}'`),
        );
      }
      return Promise.resolve(entries);
    },
    mkdir: (path: string, options?: { readonly recursive?: boolean }) => {
      const ok = host.mkdir(path, options);
      if (!ok) {
        return Promise.reject(new Error(`mkdir failed for '${path}'`));
      }
      return Promise.resolve();
    },
    rm: (path: string, options?: { readonly recursive?: boolean }) => {
      const ok = host.rm(path, options);
      if (!ok) {
        return Promise.reject(new Error(`rm failed for '${path}'`));
      }
      return Promise.resolve();
    },
  };

  return mergeRuntimeServices({
    platform: () => 'bun',
    version: () => host.version,
    hostname: () => host.hostname,
    env: host.env as Readonly<Record<string, string | undefined>>,
    exit: (code?: number) => host.exit(code),
    fs,
  });
}

/**
 * Default Bun host built from the real `Bun` global.
 * Only evaluated when no host is injected.
 */
const defaultBunHost: BunHost = (globalThis as { Bun?: BunHost }).Bun! as BunHost;
