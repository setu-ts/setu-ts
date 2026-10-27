/** Node-only handle-based I/O, installed at the CLI executable's process boundary. */
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { access, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

/**
 * Reads only the regular file actually opened, never allocating beyond the byte bound.
 *
 * Opened with `O_NOFOLLOW`, like the writer below: a link as the file itself is
 * refused rather than followed (M120 audit F1 — a pull request linking a
 * manifest to a host file made the CLI read it and echo part of it in a parse
 * error). Linked DIRECTORIES above it are the callers' `assertInsideProject`.
 */
export async function readRegularFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, regularFileFlags(constants) | (constants.O_NOFOLLOW ?? 0)).catch(
    (cause: unknown) => {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ELOOP') {
        throw new Error(`${path}: is a symbolic link; Setu does not read through links`, {
          cause,
        });
      }
      throw cause;
    },
  );
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
  O_WRONLY: number;
  O_CREAT: number;
  O_EXCL: number;
  O_NOFOLLOW?: number;
  O_NOCTTY?: number;
}): number {
  return (
    flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | (flags.O_NOFOLLOW ?? 0) | (flags.O_NOCTTY ?? 0)
  );
}

/**
 * Snapshots read-only, then replaces the directory entry with a fresh same-directory inode.
 * An existing target's temp is created owner-only (0o600), so its private bytes are never
 * readable by others mid-write; after writing it receives the target's owner and group and
 * only its 0o777 permission bits, never setuid, setgid or sticky. A target the invoking user
 * cannot write is refused, as is one whose owner or group cannot be kept. ACLs and extended
 * attributes are not carried over. A new target's temp uses 0o666 minus the umask.
 * Cleanup covers handled failures only: a process killed between temp creation and rename
 * can leave a .<name>.setu-<hex>.tmp file in the target directory.
 * @param path - Target whose parent chain the caller has checked.
 * @param bytes - Replacement bytes.
 * @param maxExistingBytes - Maximum prior content to retain for undo.
 * @returns Prior bytes, or undefined when the snapshot found no target.
 * @throws Snapshot errors (including close) before any mutation; no undo is needed.
 * @throws RegularFileWriteError with undo bytes if temp creation, writing, close or rename fails;
 *   `mayHaveChanged` is true only when the rename was attempted.
 */
export async function writeRegularFile(
  path: string,
  bytes: Uint8Array,
  maxExistingBytes: number,
): Promise<{ before: Uint8Array | undefined }> {
  const refusal = `${path}: expected a regular file at most 1 MiB`;
  const handle = await open(path, regularFileFlags(constants) | (constants.O_NOFOLLOW ?? 0)).catch(
    (cause: unknown) => {
      if (cause instanceof Error && 'code' in cause) {
        if (cause.code === 'ENOENT') return undefined;
        if (cause.code === 'ELOOP') throw new Error(refusal, { cause });
      }
      throw cause;
    },
  );
  let before: Uint8Array | undefined;
  let existing: { mode: number; uid: number; gid: number } | undefined;
  if (handle !== undefined) {
    try {
      const stat = await handle.stat();
      // Keep a clear refusal for static hard links. Security does not depend on
      // nlink staying stable: we never write into this existing inode.
      if (!stat.isFile() || stat.nlink > 1 || stat.size > maxExistingBytes) {
        throw new Error(refusal);
      }
      existing = { mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
      const previous = new Uint8Array(maxExistingBytes);
      let length = 0;
      while (length < previous.length) {
        const { bytesRead } = await handle.read(previous, length, previous.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length === maxExistingBytes) {
        const { bytesRead } = await handle.read(new Uint8Array(1), 0, 1, null);
        if (bytesRead !== 0) throw new Error(refusal);
      }
      before = previous.slice(0, length);
    } finally {
      // Finish all read-only I/O before creating a temp. A snapshot close failure
      // therefore leaves the target untouched and needs no RegularFileWriteError undo.
      await handle.close();
    }
    // The old in-place writer could not open a read-only target; renaming over it
    // would silently replace it, so keep refusing. This is a usability guard, not
    // the security boundary (no existing inode is ever written through).
    await access(path, constants.W_OK).catch((cause: unknown) => {
      // The name vanished after the snapshot: the rename recreates it.
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return;
      throw new Error(`${path}: not writable`, { cause });
    });
  }
  const temp = join(
    dirname(path),
    `.${basename(path)}.setu-${randomBytes(16).toString('hex')}.tmp`,
  );
  let created = false;
  // rename is the only step that can alter the target; earlier failures leave it untouched.
  let renameStarted = false;
  // Thrown before rename, so the target is untouched: no undo is attempted.
  let ownerRefusal: Error | undefined;
  try {
    const output = await open(
      temp,
      regularFileWriteFlags(constants),
      existing === undefined ? 0o666 : 0o600,
    ).catch((cause: unknown) => {
      // The temp name is ours, not the developer's: naming it in a refusal is
      // noise, and it must never be mistaken for the target. The raw errno is
      // kept as the cause for anyone diagnosing it.
      if (
        cause instanceof Error &&
        'code' in cause &&
        (cause.code === 'EACCES' || cause.code === 'EPERM')
      )
        throw new Error(`${path}: permission denied creating a file in ${dirname(path)}`, {
          cause,
        });
      throw cause;
    });
    created = true;
    try {
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await output.write(
          bytes,
          written,
          bytes.length - written,
          written,
        );
        if (bytesWritten === 0) throw new Error(`${path}: write made no progress`);
        written += bytesWritten;
      }
      if (existing !== undefined) {
        const tempStat = await output.stat();
        if (tempStat.uid !== existing.uid || tempStat.gid !== existing.gid) {
          const { uid, gid } = existing;
          await output.chown(uid, gid).catch((cause: unknown) => {
            ownerRefusal = new Error(`${path}: cannot keep the file's owner or group`, { cause });
            throw ownerRefusal;
          });
        }
        // After chown, which may clear permission bits.
        await output.chmod(existing.mode);
      }
    } finally {
      await output.close();
    }
    renameStarted = true;
    await rename(temp, path);
    return { before };
  } catch (cause) {
    if (created)
      await unlink(temp).catch(() => {
        /* Best-effort cleanup; preserve the write failure. */
      });
    if (cause === ownerRefusal) throw cause;
    throw new RegularFileWriteError(before, cause, renameStarted);
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
    canWrite: async (path: string) => {
      // The writer always creates a temp file beside the target and renames it
      // over, so the directory must be writable even when the target is.
      try {
        await access(dirname(path), constants.W_OK);
      } catch {
        return false;
      }
      try {
        await access(path, constants.W_OK);
        return true;
      } catch (cause) {
        // A missing target is created; any other error on it is a refusal.
        return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
      }
    },
    ...(typeof process.getuid !== 'function'
      ? {}
      : {
          invokingUid: process.getuid(),
          directoryOwnership: async (path: string) => {
            const stat = await lstat(path);
            return {
              uid: stat.uid,
              isSymbolicLink: stat.isSymbolicLink(),
              isDirectory: stat.isDirectory(),
            };
          },
        }),
  };
}
