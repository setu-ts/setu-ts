import { constants } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegularFileWriteError, writeFiles } from '../../../src/utils/file-writer.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

const io = vi.hoisted(() => ({
  input: { stat: vi.fn(), read: vi.fn(), close: vi.fn() },
  output: { write: vi.fn(), chmod: vi.fn(), chown: vi.fn(), stat: vi.fn(), close: vi.fn() },
  open: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  open: io.open,
  rename: io.rename,
  unlink: io.unlink,
  access: io.access,
}));
import {
  regularFileFlags,
  regularFileWriteFlags,
  writeRegularFile,
} from '../../../src/utils/node-regular-file.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ioError = (code: string): Error => Object.assign(new Error(code), { code });

beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [
    io.input.close,
    io.output.close,
    io.output.chmod,
    io.output.chown,
    io.rename,
    io.unlink,
    io.access,
  ])
    method.mockResolvedValue(undefined);
  io.open.mockResolvedValueOnce(io.input).mockResolvedValue(io.output);
  io.input.stat.mockResolvedValue({
    isFile: () => true,
    size: 3,
    nlink: 1,
    mode: 0o100640,
    uid: 1000,
    gid: 1000,
  });
  io.output.stat.mockResolvedValue({ uid: 1000, gid: 1000 });
  io.input.read
    .mockImplementationOnce((buffer: Uint8Array) => {
      buffer.set(bytes('old'));
      return Promise.resolve({ bytesRead: 3 });
    })
    .mockResolvedValue({ bytesRead: 0 });
  io.output.write.mockImplementation((_buffer: Uint8Array, _offset: number, length: number) =>
    Promise.resolve({ bytesWritten: length }),
  );
});

describe('snapshot then rename writer', () => {
  it('reads without write/create flags, writes a fresh exclusive temp, chmods and closes before rename', async () => {
    expect(await writeRegularFile('/target', bytes('new'), 10)).toEqual({ before: bytes('old') });
    expect(io.open.mock.calls[0]).toEqual([
      '/target',
      regularFileFlags(constants) | constants.O_NOFOLLOW,
    ]);
    expect(io.open.mock.calls[1]).toEqual([
      expect.stringMatching(/^\/\.target\.setu-[a-f0-9]{32}\.tmp$/),
      regularFileWriteFlags(constants),
      0o600,
    ]);
    expect(io.output.chmod).toHaveBeenCalledWith(0o640);
    expect(io.output.chown).not.toHaveBeenCalled();
    expect(io.output.write).toHaveBeenCalledWith(bytes('new'), 0, 3, 0);
    expect(io.input.close.mock.invocationCallOrder[0]).toBeLessThan(
      io.output.write.mock.invocationCallOrder[0]!,
    );
    expect(io.output.close.mock.invocationCallOrder[0]).toBeLessThan(
      io.rename.mock.invocationCallOrder[0]!,
    );
    expect(io.rename).toHaveBeenCalledWith(io.open.mock.calls[1]![0], '/target');
    expect(io.unlink).not.toHaveBeenCalled();
  });

  it.each([new Error('denied'), 'open failed', { code: 'ENOENT' }])(
    'preserves unrecognized snapshot open errors: %j',
    async (cause) => {
      io.open.mockReset().mockRejectedValue(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toBe(cause);
      expect(io.open).toHaveBeenCalledOnce();
    },
  );

  it('maps ELOOP to the existing refusal', async () => {
    const cause = ioError('ELOOP');
    io.open.mockReset().mockRejectedValue(cause);
    await expect(writeRegularFile('/link', bytes('new'), 10)).rejects.toMatchObject({
      message: '/link: expected a regular file at most 1 MiB',
      cause,
    });
  });

  it('creates an absent target without chmod', async () => {
    io.open.mockReset().mockRejectedValueOnce(ioError('ENOENT')).mockResolvedValue(io.output);
    expect(await writeRegularFile('/new', bytes('new'), 10)).toEqual({ before: undefined });
    expect(io.output.chmod).not.toHaveBeenCalled();
    expect(io.open.mock.calls[1]![2]).toBe(0o666);
    expect(io.access).not.toHaveBeenCalled();
  });

  it('refuses a target the invoking user cannot write, before creating a temp', async () => {
    const cause = ioError('EACCES');
    io.access.mockRejectedValue(cause);
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
      message: '/target: not writable',
      cause,
    });
    expect(io.access).toHaveBeenCalledWith('/target', constants.W_OK);
    expect(io.open).toHaveBeenCalledOnce();
  });

  it('proceeds when the target name vanished after the snapshot', async () => {
    io.access.mockRejectedValue(ioError('ENOENT'));
    expect(await writeRegularFile('/target', bytes('new'), 10)).toEqual({ before: bytes('old') });
    expect(io.rename).toHaveBeenCalledOnce();
  });

  it('keeps the owner and group, then applies the mode after chown', async () => {
    io.output.stat.mockResolvedValue({ uid: 1000, gid: 50 });
    await writeRegularFile('/target', bytes('new'), 10);
    expect(io.output.chown).toHaveBeenCalledWith(1000, 1000);
    expect(io.output.chown.mock.invocationCallOrder[0]).toBeLessThan(
      io.output.chmod.mock.invocationCallOrder[0]!,
    );
  });

  it('refuses when the owner or group cannot be kept, leaving the target untouched', async () => {
    const cause = ioError('EPERM');
    io.output.stat.mockResolvedValue({ uid: 0, gid: 1000 });
    io.output.chown.mockRejectedValue(cause);
    const error = await writeRegularFile('/target', bytes('new'), 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegularFileWriteError);
    expect((error as RegularFileWriteError).cause).toMatchObject({
      message: "/target: cannot keep the file's owner or group",
      cause,
    });
    expect(io.rename).not.toHaveBeenCalled();
    expect(io.unlink).toHaveBeenCalledOnce();
  });

  it.each([
    { isFile: () => false, size: 0, nlink: 1 },
    { isFile: () => true, size: 11, nlink: 1 },
    { isFile: () => true, size: 3, nlink: 2 },
  ])('refuses unsafe metadata before reading: %j', async (stat) => {
    io.input.stat.mockResolvedValue(stat);
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toThrow(
      'expected a regular file',
    );
    expect(io.input.read).not.toHaveBeenCalled();
    expect(io.open).toHaveBeenCalledOnce();
    expect(io.input.close).toHaveBeenCalledOnce();
  });

  it('bounds growth after fstat with a single overflow byte', async () => {
    io.input.read
      .mockReset()
      .mockImplementation((buffer: Uint8Array, offset: number, length: number) => {
        expect(buffer.length).toBeLessThanOrEqual(10);
        buffer.fill(65, offset, offset + length);
        return Promise.resolve({ bytesRead: length });
      });
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toThrow(
      'expected a regular file',
    );
    expect(io.input.read.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 10, null],
      [0, 1, null],
    ]);
    expect(io.open).toHaveBeenCalledOnce();
  });

  it('continues short reads and short writes', async () => {
    let reads = 0;
    io.input.read.mockReset().mockImplementation((buffer: Uint8Array, offset: number) => {
      if (reads++ === 2) return Promise.resolve({ bytesRead: 0 });
      buffer[offset] = 65 + offset;
      return Promise.resolve({ bytesRead: 1 });
    });
    io.output.write.mockResolvedValue({ bytesWritten: 1 });
    expect(await writeRegularFile('/target', bytes('new'), 10)).toEqual({ before: bytes('AB') });
    expect(io.output.write.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 3, 0],
      [1, 2, 1],
      [2, 1, 2],
    ]);
  });

  it.each(['stat', 'read', 'close'] as const)(
    'closes the snapshot on %s failure without creating a temp',
    async (method) => {
      const cause = new Error(method);
      io.input[method].mockReset().mockRejectedValue(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toThrow(method);
      expect(io.input.close).toHaveBeenCalledOnce();
      expect(io.open).toHaveBeenCalledOnce();
    },
  );

  it('does not unlink a temp it failed to create', async () => {
    const cause = ioError('EEXIST');
    io.open.mockReset().mockResolvedValueOnce(io.input).mockRejectedValue(cause);
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
      name: 'RegularFileWriteError',
      before: bytes('old'),
      cause,
    });
    expect(io.unlink).not.toHaveBeenCalled();
  });

  it.each(['write', 'chmod', 'close'] as const)(
    'cleans temp and retains undo on output %s failure',
    async (method) => {
      const cause = new Error(method);
      io.output[method].mockRejectedValue(cause);
      await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
        name: 'RegularFileWriteError',
        before: bytes('old'),
        cause,
      });
      expect(io.output.close).toHaveBeenCalledOnce();
      expect(io.rename).not.toHaveBeenCalled();
      expect(io.unlink).toHaveBeenCalledWith(io.open.mock.calls[1]![0]);
    },
  );

  it('preserves rename failure when cleanup also fails', async () => {
    const cause = new Error('rename denied');
    io.rename.mockRejectedValue(cause);
    io.unlink.mockRejectedValue(new Error('cleanup denied'));
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
      name: 'RegularFileWriteError',
      before: bytes('old'),
      cause,
    });
    expect(io.unlink).toHaveBeenCalledOnce();
  });

  it('rejects zero-progress writes and cleans temp', async () => {
    io.output.write.mockResolvedValue({ bytesWritten: 0 });
    await expect(writeRegularFile('/target', bytes('new'), 10)).rejects.toMatchObject({
      name: 'RegularFileWriteError',
      before: bytes('old'),
      message: '/target: write made no progress',
    });
    expect(io.unlink).toHaveBeenCalledOnce();
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
