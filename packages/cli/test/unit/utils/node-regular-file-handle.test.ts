import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';

const handle = vi.hoisted(() => ({
  stat: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));
const open = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ open }));
import { readRegularFile } from '../../../src/utils/node-regular-file.ts';

beforeEach(() => {
  vi.resetAllMocks();
  open.mockResolvedValue(handle);
  handle.stat.mockResolvedValue({ isFile: () => true, size: 1 });
  handle.close.mockResolvedValue(undefined);
});

describe('opened-handle bounded read', () => {
  it('fstats the opened handle before reading and closes on non-regular refusal', async () => {
    handle.stat.mockResolvedValue({ isFile: () => false, size: 0 });
    await expect(readRegularFile('/swapped-path', 10)).rejects.toThrow('regular file');
    expect(open).toHaveBeenCalledWith(
      '/swapped-path',
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW,
    );
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('refuses a link as the file itself, naming it, and passes other open errors through', async () => {
    // M120 audit F1: O_NOFOLLOW makes the kernel answer ELOOP for a final-component link.
    open.mockRejectedValueOnce(Object.assign(new Error('ELOOP'), { code: 'ELOOP' }));
    await expect(readRegularFile('/linked', 10)).rejects.toThrow(
      '/linked: is a symbolic link; Setu does not read through links',
    );
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    open.mockRejectedValueOnce(missing);
    await expect(readRegularFile('/missing', 10)).rejects.toBe(missing);
    expect(handle.read).not.toHaveBeenCalled();
  });

  it('bounds a growing file despite small fstat size and closes after overflow', async () => {
    handle.read.mockImplementation((bytes: Uint8Array, offset: number, length: number) => {
      bytes.fill(65, offset, offset + length);
      return Promise.resolve({ bytesRead: length });
    });
    await expect(readRegularFile('/growing', 10)).rejects.toThrow('regular file at most 1 MiB');
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.read.mock.calls[0]?.slice(1)).toEqual([0, 11, null]);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('continues short reads on the same handle until EOF', async () => {
    let reads = 0;
    handle.read.mockImplementation((bytes: Uint8Array, offset: number) => {
      if (reads++ === 2) return Promise.resolve({ bytesRead: 0 });
      bytes[offset] = 65;
      return Promise.resolve({ bytesRead: 1 });
    });
    expect(await readRegularFile('/partial', 10)).toEqual(new Uint8Array([65, 65]));
    expect(handle.read.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 11, null],
      [1, 10, null],
      [2, 9, null],
    ]);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['stat', 'read'] as const)('closes if handle.%s fails', async (method) => {
    handle[method].mockRejectedValue(new Error('I/O failure'));
    await expect(readRegularFile('/file', 10)).rejects.toThrow('I/O failure');
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
