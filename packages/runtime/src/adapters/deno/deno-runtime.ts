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

import type { IDnsResolver, IFileSystem, IRuntimeServices, IWorkerHost } from '@setu-ts/common';
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
  /** Open a file for reading. */
  open(path: string): Promise<Deno.FsFile>;
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
    readStream: async (
      path: string,
      options?: { readonly start?: number; readonly end?: number },
    ): Promise<ReadableStream<Uint8Array>> => {
      const file = await host.open(path);
      let cancelled = false;
      let closed = false;
      let bytesWritten = 0;
      let bytesRemaining = Infinity;

      // Deno FsFile.readable has no range parameter — when a range is
      // requested we seek to start and enforce an explicit byte limit so the
      // stream closes after exactly end - start + 1 bytes.
      if (options?.start !== undefined) {
        await file.seek(options.start, Deno.SeekMode.Start);
        if (options.end !== undefined) {
          bytesRemaining = options.end - options.start + 1;
        }
      }

      const closeFile = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await file.close();
        } catch {
          // Ignore close errors — the stream is already terminating.
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cancelled) {
            await closeFile();
            controller.close();
            return;
          }

          if (bytesWritten >= bytesRemaining) {
            await closeFile();
            controller.close();
            return;
          }

          const chunkSize = Math.min(64 * 1024, bytesRemaining - bytesWritten);
          const buffer = new Uint8Array(chunkSize);
          let totalRead = 0;

          try {
            while (totalRead < chunkSize) {
              const bytesRead = await file.read(buffer.subarray(totalRead));
              if (bytesRead === 0 || bytesRead === null) {
                break;
              }
              totalRead += bytesRead;
            }
          } catch (error) {
            await closeFile();
            controller.error(error);
            return;
          }

          if (totalRead === 0) {
            await closeFile();
            controller.close();
            return;
          }

          bytesWritten += totalRead;
          controller.enqueue(buffer.subarray(0, totalRead));

          if (bytesWritten >= bytesRemaining) {
            await closeFile();
          }
        },
        cancel: async () => {
          cancelled = true;
          await closeFile();
        },
      });

      return stream;
    },
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
