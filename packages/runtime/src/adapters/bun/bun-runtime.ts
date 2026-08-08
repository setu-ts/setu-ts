/**
 * Bun runtime adapter — provides {@linkcode IRuntimeServices} on Bun.
 *
 * Uses dependency injection: a {@linkcode BunHost} interface exposes only the
 * Bun-specific operations needed, so unit tests can pass a fake host.
 *
 * The default host is built by {@linkcode buildBunHost} from static `node:`
 * built-ins (`node:fs`, `node:os`, `node:process`), which Bun implements — NOT
 * from members of the `Bun` global. Bun's own file API is `Bun.file()` /
 * `Bun.write()`; it has no `Bun.readFile`, `Bun.stat`, `Bun.readdir`,
 * `Bun.mkdir`, `Bun.rm`, `Bun.realPath`, `Bun.hostname`, or `Bun.exit`, so the
 * previous `globalThis.Bun as BunHost` cast produced a host whose file-system,
 * hostname, and exit members were all `undefined` at runtime. Only
 * `Bun.version` is read from the global (when present).
 *
 * @module
 */

import type { IDnsResolver, IFileSystem, IRuntimeServices, IWorkerHost } from '@setu-ts/common';
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import process from 'node:process';
import { mergeRuntimeServices } from '../../services/cross-runtime.ts';
import { createWebWorkerHost } from '../shared/web-worker-host.ts';
import { createNodeDnsResolver } from '../shared/node-dns-resolver.ts';

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
  /** Resolve a path to its canonical absolute form (null when it cannot be resolved). */
  realPath: (path: string) => string | null;
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
  /**
   * Create a read stream for a file.
   * Returns null if the file cannot be opened.
   */
  createReadStream?: (
    path: string,
    options?: { start?: number; end?: number },
  ) => NodeJS.ReadableStream | null;
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
 * @param host - Injected Bun host (defaults to {@linkcode buildBunHost}, which
 * is backed by `node:` built-ins — NOT by members of the `Bun` global)
 * @param workers - Injected worker host (defaults to the web `Worker` host)
 * @param dns - Injected DNS resolver (defaults to the shared `node:dns/promises`
 * resolver, which Bun implements)
 * @returns Complete runtime services for Bun
 */
export function createBunRuntimeServices(
  host: BunHost = buildBunHost(),
  workers: IWorkerHost = createWebWorkerHost(),
  dns: IDnsResolver = createNodeDnsResolver(),
): IRuntimeServices {
  const fs: IFileSystem = {
    readFile: (path: string) => {
      const data = host.readFile(path);
      if (data === null) {
        return Promise.reject(new Error(`ENOENT: no such file or directory, read '${path}'`));
      }
      return Promise.resolve(data);
    },
    realPath: (path: string) => {
      const resolved = host.realPath(path);
      if (resolved === null) {
        return Promise.reject(
          new Error(`ENOENT: no such file or directory, realpath '${path}'`),
        );
      }
      return Promise.resolve(resolved);
    },
    writeFile: (path: string, data: Uint8Array) => {
      // `BunHost.writeFile` has no `null` channel to report failure, so a
      // failed write surfaces as a throw. Convert it to a rejection: this
      // method returns a promise, and a synchronous throw would bypass the
      // caller's `.catch` / `try { await … }`.
      try {
        host.writeFile(path, data);
      } catch (error) {
        return Promise.reject(error);
      }
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
    readStream: async (
      path: string,
      options?: { readonly start?: number; readonly end?: number },
    ): Promise<ReadableStream<Uint8Array>> => {
      if (!host.createReadStream) {
        throw new Error('readStream not supported on this Bun version');
      }
      const stream = host.createReadStream!(path, options);
      if (stream === null) {
        throw new Error('Failed to create read stream');
      }
      const { Readable } = await import('node:stream');
      const web = Readable.toWeb(stream as never);
      return web as ReadableStream<Uint8Array>;
    },
  };

  return mergeRuntimeServices({
    platform: () => 'bun',
    version: () => host.version,
    hostname: () => host.hostname,
    env: host.env as Readonly<Record<string, string | undefined>>,
    exit: (code?: number) => host.exit(code),
    fs,
    workers,
    dns,
  });
}

/**
 * The built-ins {@linkcode buildBunHost} needs, injectable so every wrapper is
 * unit-testable without real file-system access. Shapes match `node:fs` (sync),
 * `node:os`, and `node:process`, all of which Bun implements.
 */
export interface BunModules {
  /** Synchronous file-system operations (compatible with `node:fs`). */
  fs: {
    readFileSync(path: string): Uint8Array;
    realpathSync(path: string): string;
    writeFileSync(path: string, data: Uint8Array): void;
    statSync(path: string): {
      isFile(): boolean;
      isDirectory(): boolean;
      size: number;
      mtime: Date;
    };
    readdirSync(path: string): string[];
    mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
    rmSync(path: string, options?: { recursive?: boolean }): void;
    createReadStream?: (
      path: string,
      options?: { start?: number; end?: number },
    ) => NodeJS.ReadableStream | null;
  };
  /** Process object (version, env, exit). */
  proc: {
    version: string;
    versions: Record<string, string | undefined>;
    env: Record<string, string | undefined>;
    exit: (code?: number) => never;
  };
  /** Hostname function (from `node:os`). */
  hostname: () => string;
  /**
   * The `Bun` global when running on Bun, `undefined` elsewhere — read only for
   * its version string. Required (rather than optional) so callers and tests
   * state it explicitly and every version-resolution arm stays reachable.
   */
  bunGlobal: { version?: string } | undefined;
}

/**
 * Builds the default {@linkcode BunHost} from `node:` built-ins, which Bun
 * implements.
 *
 * Failures are reported through the host's documented channels — `null` for the
 * read/stat/resolve operations, `false` for `mkdir`/`rm` — so
 * {@linkcode createBunRuntimeServices} can turn them into rejected promises
 * with a consistent message.
 *
 * @param mods - Injectable built-ins (defaults to the real `node:` modules)
 * @returns A fully-wired BunHost
 */
export function buildBunHost(
  mods: BunModules = {
    fs: {
      readFileSync,
      realpathSync,
      writeFileSync,
      statSync,
      readdirSync,
      mkdirSync,
      rmSync,
      createReadStream,
    },
    proc: process,
    hostname: osHostname,
    bunGlobal: (globalThis as { Bun?: { version?: string } }).Bun,
  },
): BunHost {
  return {
    version: mods.bunGlobal?.version ?? mods.proc.versions.bun ?? mods.proc.version,
    hostname: mods.hostname(),
    env: mods.proc.env,
    exit: (code?: number) => mods.proc.exit(code),
    readFile: (path: string) => {
      try {
        return mods.fs.readFileSync(path);
      } catch {
        return null;
      }
    },
    realPath: (path: string) => {
      try {
        return mods.fs.realpathSync(path);
      } catch {
        return null;
      }
    },
    writeFile: (path: string, data: Uint8Array) => {
      mods.fs.writeFileSync(path, data);
    },
    stat: (path: string) => {
      try {
        const st = mods.fs.statSync(path);
        return {
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          size: st.size,
          mtime: st.mtime,
        };
      } catch {
        return null;
      }
    },
    readdir: (path: string) => {
      try {
        return mods.fs.readdirSync(path);
      } catch {
        return null;
      }
    },
    mkdir: (path: string, options?: { recursive?: boolean }) => {
      try {
        mods.fs.mkdirSync(path, options);
        return true;
      } catch {
        return false;
      }
    },
    rm: (path: string, options?: { recursive?: boolean }) => {
      try {
        mods.fs.rmSync(path, options);
        return true;
      } catch {
        return false;
      }
    },
    // Returned through the host seam rather than imported inside `readStream`,
    // so the adapter's stream branches are unit-testable with a fake host.
    createReadStream: (path: string, options?: { start?: number; end?: number }) => {
      try {
        return mods.fs.createReadStream?.(path, options) ?? null;
      } catch {
        return null;
      }
    },
  };
}
