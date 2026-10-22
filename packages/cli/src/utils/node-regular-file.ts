/** Node-only handle-based I/O, installed at the CLI executable's process boundary. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IFileSystem } from '@setu-ts/common';
import { type ICliFileSystem, RegularFileWriteError } from './file-writer.ts';

/** Uses only the open flags available on the host platform. */
export function regularFileFlags(flags: {
  O_RDONLY: number;
  O_NONBLOCK?: number;
  O_NOCTTY?: number;
}): number {
  return flags.O_RDONLY | (flags.O_NONBLOCK ?? 0) | (flags.O_NOCTTY ?? 0);
}

/** Reads only the regular file actually opened, never allocating beyond the byte bound. */
export async function readRegularFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, regularFileFlags(constants));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path}: expected a regular file at most 1 MiB`);
    const bytes = new Uint8Array(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`${path}: expected a regular file at most 1 MiB`);
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Uses only the write/open safety flags defined by the host platform. */
export function regularFileWriteFlags(flags: {
  O_RDWR: number;
  O_CREAT: number;
  O_NOFOLLOW?: number;
  O_NONBLOCK?: number;
  O_NOCTTY?: number;
}): number {
  return (
    flags.O_RDWR |
    flags.O_CREAT |
    (flags.O_NOFOLLOW ?? 0) |
    (flags.O_NONBLOCK ?? 0) |
    (flags.O_NOCTTY ?? 0)
  );
}

/**
 * Snapshots and replaces only the regular file actually opened, refusing leaf links.
 * @param path - Target whose parent chain the caller has checked.
 * @param bytes - Replacement bytes.
 * @param maxExistingBytes - Maximum prior content to retain for undo.
 * @returns Prior bytes, or undefined only when this open created the file.
 * @throws RegularFileWriteError with undo bytes if mutation or close fails after capture.
 */
export async function writeRegularFile(
  path: string,
  bytes: Uint8Array,
  maxExistingBytes: number,
): Promise<{ before: Uint8Array | undefined }> {
  const flags = regularFileWriteFlags(constants);
  const refusal = `${path}: expected a regular file at most 1 MiB`;
  let created = true;
  const handle = await open(path, flags | constants.O_EXCL, 0o666).catch(async (cause: unknown) => {
    if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EEXIST') throw cause;
    created = false;
    // Do not create in the fallback: a concurrent unlink must not make an
    // actually new file look like an existing empty one to rollback.
    return await open(path, flags & ~constants.O_CREAT, 0o666).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
        throw new Error(refusal, { cause: error });
      throw error;
    });
  });
  let snapshot: { before: Uint8Array | undefined } | undefined = created
    ? { before: undefined }
    : undefined;
  try {
    try {
      const stat = await handle.stat();
      // A hard link is not caught by O_NOFOLLOW: writing through it would change
      // the other name's file, which may live outside the project.
      if (!stat.isFile() || stat.nlink > 1 || stat.size > maxExistingBytes) {
        throw new Error(refusal);
      }
      const previous = new Uint8Array(maxExistingBytes + 1);
      let length = 0;
      while (length < previous.length) {
        const { bytesRead } = await handle.read(previous, length, previous.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxExistingBytes) throw new Error(refusal);
      snapshot = { before: created ? undefined : previous.slice(0, length) };
      await handle.truncate(0);
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(
          bytes,
          written,
          bytes.length - written,
          written,
        );
        if (bytesWritten === 0) throw new Error(`${path}: write made no progress`);
        written += bytesWritten;
      }
      return snapshot;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (snapshot !== undefined) throw new RegularFileWriteError(snapshot.before, cause);
    throw cause;
  }
}

/** Keeps adapter methods bound to their original receiver when adding the CLI capability. */
export function withRegularFileReads(fs: IFileSystem): ICliFileSystem {
  return {
    ...fs,
    readFile: fs.readFile.bind(fs),
    writeFile: fs.writeFile.bind(fs),
    stat: fs.stat.bind(fs),
    readdir: fs.readdir.bind(fs),
    mkdir: fs.mkdir.bind(fs),
    rm: fs.rm.bind(fs),
    ...(fs.realPath === undefined ? {} : { realPath: fs.realPath.bind(fs) }),
    ...(fs.readStream === undefined ? {} : { readStream: fs.readStream.bind(fs) }),
    readRegularFile,
    writeRegularFile,
  };
}
