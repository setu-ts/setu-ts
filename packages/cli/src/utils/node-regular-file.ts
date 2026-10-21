/** Node-only bounded reads, installed at the CLI executable's process boundary. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IFileSystem } from '@setu-ts/common';
import type { ICliFileSystem } from './file-writer.ts';

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
  };
}
