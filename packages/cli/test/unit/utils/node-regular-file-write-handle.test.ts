import { constants } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegularFileWriteError, writeFiles } from '../../../src/utils/file-writer.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

const handle = vi.hoisted(() => ({
  stat: vi.fn(),
  read: vi.fn(),
  truncate: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
}));
const open = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ open }));
import { regularFileWriteFlags, writeRegularFile } from '../../../src/utils/node-regular-file.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ioError = (code: string): Error => Object.assign(new Error(code), { code });

beforeEach(() => {
  vi.resetAllMocks();
  // Default to an existing file containing "old".
  open.mockRejectedValueOnce(ioError('EEXIST')).mockResolvedValue(handle);
  handle.stat.mockResolvedValue({ isFile: () => true, size: 3 });
  handle.read
    .mockImplementationOnce((buffer: Uint8Array) => {
      buffer.set(bytes('old'));
      return Promise.resolve({ bytesRead: 3 });
    })
    .mockResolvedValue({ bytesRead: 0 });
  handle.truncate.mockResolvedValue(undefined);
  handle.write.mockImplementation((_buffer: Uint8Array, _offset: number, length: number) =>
    Promise.resolve({ bytesWritten: length }),
  );
  handle.close.mockResolvedValue(undefined);
});

describe('opened-handle bounded write', () => {
  it('opens exclusively first, then opens an existing file without create or truncate flags', async () => {
    expect(await writeRegularFile('/target', bytes('new'), 10)).toEqual({ before: bytes('old') });
    const flags = regularFileWriteFlags(constants);
    expect(open.mock.calls).toEqual([
      ['/target', flags | constants.O_EXCL, 0o666],
      ['/target', flags & ~constants.O_CREAT, 0o666],
    ]);
    expect(handle.stat.mock.invocationCallOrder[0]).toBeLessThan(
      handle.read.mock.invocationCallOrder[0]!,
    );
    expect(handle.read.mock.invocationCallOrder[1]).toBeLessThan(
      handle.truncate.mock.invocationCallOrder[0]!,
    );
    expect(handle.truncate).toHaveBeenCalledWith(0);
    expect(handle.write).toHaveBeenCalledWith(bytes('new'), 0, 3, 0);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each([new Error('denied'), 'open failed', { code: 'EEXIST' }])(
    'preserves non-EEXIST open failures without attempting another open: %j',
    async (cause) => {
      open.mockReset().mockRejectedValue(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toBe(cause);
      expect(open).toHaveBeenCalledOnce();
      expect(handle.close).not.toHaveBeenCalled();
    },
  );

  it.each([ioError('ENOENT'), new Error('denied'), 'fallback failed', { code: 'ELOOP' }])(
    'preserves fallback failures without creating a disappeared leaf: %j',
    async (cause) => {
      open.mockReset().mockRejectedValueOnce(ioError('EEXIST')).mockRejectedValueOnce(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toBe(cause);
      expect(open).toHaveBeenCalledTimes(2);
      expect(handle.stat).not.toHaveBeenCalled();
      expect(handle.close).not.toHaveBeenCalled();
    },
  );

  it('maps ELOOP to the regular-file refusal and preserves its cause', async () => {
    const cause = ioError('ELOOP');
    open.mockReset().mockRejectedValueOnce(ioError('EEXIST')).mockRejectedValueOnce(cause);
    await expect(writeRegularFile('/link', bytes('new'), 10)).rejects.toMatchObject({
      message: '/link: expected a regular file at most 1 MiB',
      cause,
    });
    expect(handle.truncate).not.toHaveBeenCalled();
  });

  it.each([
    { isFile: () => false, size: 0 },
    { isFile: () => true, size: 11 },
  ])('refuses handle metadata before reading or truncating: %j', async (stat) => {
    handle.stat.mockResolvedValue(stat);
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toThrow(
      'expected a regular file',
    );
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.truncate).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('bounds a file growing after fstat without truncating it', async () => {
    handle.read
      .mockReset()
      .mockImplementation((buffer: Uint8Array, offset: number, length: number) => {
        expect(buffer.length).toBe(11);
        buffer.fill(65, offset, offset + length);
        return Promise.resolve({ bytesRead: length });
      });
    await expect(writeRegularFile('/growing', bytes('new'), 10)).rejects.toThrow(
      'expected a regular file',
    );
    expect(handle.read.mock.calls[0]?.slice(1)).toEqual([0, 11, null]);
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.truncate).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('continues short reads and positioned writes through the same handle', async () => {
    let reads = 0;
    handle.read.mockReset().mockImplementation((buffer: Uint8Array, offset: number) => {
      if (reads++ === 2) return Promise.resolve({ bytesRead: 0 });
      buffer[offset] = 65 + offset;
      return Promise.resolve({ bytesRead: 1 });
    });
    handle.write.mockResolvedValue({ bytesWritten: 1 });
    expect(await writeRegularFile('/partial', bytes('new'), 10)).toEqual({ before: bytes('AB') });
    expect(handle.read.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 11, null],
      [1, 10, null],
      [2, 9, null],
    ]);
    expect(handle.write.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 3, 0],
      [1, 2, 1],
      [2, 1, 2],
    ]);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['stat', 'read'] as const)(
    'closes but does not record undo when existing handle.%s fails before capture',
    async (method) => {
      const cause = new Error(`${method} failed`);
      handle[method].mockReset().mockRejectedValue(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toBe(cause);
      expect(handle.truncate).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it.each(['stat', 'read'] as const)(
    'records absent undo for cleanup when a newly created handle.%s fails',
    async (method) => {
      open.mockReset().mockResolvedValue(handle);
      const cause = new Error(`${method} failed`);
      handle[method].mockReset().mockRejectedValue(cause);
      await expect(writeRegularFile('/new', bytes('new'), 10)).rejects.toMatchObject({
        name: 'RegularFileWriteError',
        before: undefined,
        cause,
      });
      expect(handle.truncate).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it.each(['truncate', 'write', 'close'] as const)(
    'retains undo and cause when handle.%s fails after capture',
    async (method) => {
      const cause = new Error(`${method} failed`);
      handle[method].mockRejectedValue(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
        name: 'RegularFileWriteError',
        before: bytes('old'),
        cause,
        message: cause.message,
      });
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it('rejects zero-progress writes with undo instead of looping forever', async () => {
    handle.write.mockResolvedValue({ bytesWritten: 0 });
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
      name: 'RegularFileWriteError',
      before: bytes('old'),
      message: '/target: write made no progress',
    });
    expect(handle.write).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('retains absent undo when close fails after creating a file', async () => {
    open.mockReset().mockResolvedValue(handle);
    handle.close.mockRejectedValue('close failed');
    await expect(writeRegularFile('/new', bytes('new'), 10)).rejects.toMatchObject({
      name: 'RegularFileWriteError',
      before: undefined,
      cause: 'close failed',
      message: 'close failed',
    });
  });
});

describe('writeFiles handle-error recovery', () => {
  it.each([undefined, '', 'original'])(
    'recovers the failing write itself with prior bytes %j',
    async (prior) => {
      const fs = createFakeFs(prior === undefined ? {} : { '/project/target': prior });
      let calls = 0;
      const cause = new Error('partial write failed');
      const capable = {
        ...fs,
        async writeRegularFile(path: string, data: Uint8Array) {
          if (calls++ === 0) {
            await fs.writeFile(path, bytes('partial'));
            throw new RegularFileWriteError(prior === undefined ? undefined : bytes(prior), cause);
          }
          await fs.writeFile(path, data);
          return { before: bytes('partial') };
        },
      };
      await expect(
        writeFiles(capable, [{ path: '/project/target', contents: 'new' }], { root: '/project' }),
      ).rejects.toMatchObject({ name: 'RegularFileWriteError', cause });
      if (prior === undefined) expect(fs.has('/project/target')).toBe(false);
      else expect(fs.read('/project/target')).toBe(prior);
      expect(calls).toBe(prior === undefined ? 1 : 2);
    },
  );
});
