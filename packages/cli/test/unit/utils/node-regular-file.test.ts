import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  readRegularFile,
  regularFileFlags,
  withRegularFileReads,
} from '../../../src/utils/node-regular-file.ts';
import { MAX_EXISTING_FILE_BYTES } from '../../../src/utils/file-writer.ts';
import { isMissingPath } from '../../../src/utils/filesystem-errors.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

const exec = promisify(execFile);
let root: string;
beforeAll(async () => {
  const scratch = resolve(process.env['M116_TEST_SCRATCH'] ?? '.tmp');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(`${scratch}/m116-bounded-`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Node bounded reader', () => {
  it('accepts exactly 1 MiB and refuses 1 MiB + 1', async () => {
    for (const size of [MAX_EXISTING_FILE_BYTES, MAX_EXISTING_FILE_BYTES + 1]) {
      const path = `${root}/${size}`;
      await writeFile(path, new Uint8Array(size).fill(65));
      if (size === MAX_EXISTING_FILE_BYTES) {
        expect(await readRegularFile(path, MAX_EXISTING_FILE_BYTES)).toEqual(
          new Uint8Array(size).fill(65),
        );
      } else {
        await expect(readRegularFile(path, MAX_EXISTING_FILE_BYTES)).rejects.toThrow(
          'expected a regular file at most 1 MiB',
        );
      }
      await rm(path);
    }
  });

  it('accepts short and empty regular files', async () => {
    for (const text of ['', 'hello']) {
      const path = `${root}/short`;
      await writeFile(path, text);
      expect(new TextDecoder().decode(await readRegularFile(path, 10))).toBe(text);
    }
  });

  it('preserves ENOENT and refuses a directory', async () => {
    const missing = await readRegularFile(`${root}/missing`, 10).catch((cause) => cause);
    expect(missing.code).toBe('ENOENT');
    expect(isMissingPath(missing)).toBe(true);
    await expect(readRegularFile(root, 10)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO promptly',
    async () => {
      const path = `${root}/pipe`;
      await exec('mkfifo', [path]);
      await expect(readRegularFile(path, MAX_EXISTING_FILE_BYTES)).rejects.toThrow(
        'expected a regular file at most 1 MiB',
      );
    },
    1500,
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink to /dev/zero promptly',
    async () => {
      const path = `${root}/device`;
      await symlink('/dev/zero', path);
      const probePath = `${root}/handle-probe`;
      await writeFile(probePath, '');
      const probe = await open(probePath, 'r');
      const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, 'read'>;
      await probe.close();
      const read = vi.spyOn(prototype, 'read');
      try {
        await expect(readRegularFile(path, MAX_EXISTING_FILE_BYTES)).rejects.toThrow(
          'is a symbolic link; Setu does not read through links',
        );
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    },
    1500,
  );

  it('uses available platform flags', () => {
    expect(regularFileFlags({ O_RDONLY: 1 })).toBe(1);
    expect(regularFileFlags({ O_RDONLY: 1, O_NONBLOCK: 2, O_NOCTTY: 4 })).toBe(7);
  });

  it('binds every adapter method, including optional methods', async () => {
    const fs = createFakeFs({ '/file': 'value' });
    const receiver = {
      ...fs,
      readFile(path: string) {
        expect(this).toBe(receiver);
        return fs.readFile(path);
      },
      readStream() {
        expect(this).toBe(receiver);
        return Promise.resolve(new ReadableStream<Uint8Array>());
      },
    };
    const wrapped = withRegularFileReads(receiver);
    expect(new TextDecoder().decode(await wrapped.readFile('/file'))).toBe('value');
    await wrapped.writeFile('/other', new Uint8Array());
    expect((await wrapped.stat('/other')).isFile).toBe(true);
    expect(await wrapped.readdir('')).toContain('file');
    await wrapped.mkdir('/dir');
    await wrapped.rm('/other');
    expect(await wrapped.realPath!('/file')).toBe('/file');
    expect(await wrapped.readStream!('/file')).toBeInstanceOf(ReadableStream);
    const { realPath, ...withoutOptionals } = fs;
    expect(realPath).toBeDefined();
    expect(withRegularFileReads(withoutOptionals).realPath).toBeUndefined();
    expect(withRegularFileReads(withoutOptionals).readStream).toBeUndefined();
    expect(wrapped.readRegularFile).toBe(readRegularFile);
  });
});
